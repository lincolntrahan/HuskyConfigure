--[[
husky.lua — HuskyConfigure companion script (prototype v0.1)

Jobs:
  1. RC-loss failsafe pose: when RC has been invalid for HSK_FS_DLY ms, hold every output
     that has a non-zero HSK_FS_PWMn at that PWM. Released automatically when RC returns
     (we stop refreshing a short override timeout), and also if this script stops.
  2. Arming gate: registers as an auxiliary arming authoriser, so the vehicle can't arm
     unless this script is running and its checks pass (HSK_GATE bitmask).
  3. Heartbeat: NAMED_VALUE_FLOAT "HSK" once a second (value = state, see STATE_*).

All values are written by HuskyConfigure from the aircraft profile. Nobody should need to
edit them by hand. HSK_CFG_HASH lets the gate detect that someone did.

Not yet in this prototype: the mixer for scripted surfaces (spoilerons etc).
]]

local VERSION = 1           -- reported in the heartbeat; bump with any behavior change
local PARAM_KEY = 74        -- parameter table key, must be unique among running scripts
local PREFIX = "HSK_"
local LOOP_MS = 20          -- 50 Hz, Plane's main loop rate
local OVERRIDE_MS = 200     -- each refresh holds an output this long
local NUM_OUT = 16

-- gate bits (HSK_GATE)
local GATE_RC = 1           -- RC link must be valid
local GATE_CFG = 2          -- HSK_CFG_HASH must match the other HSK_ params
local GATE_FS = 4           -- failsafe table must have at least one output

-- heartbeat states
local STATE_OK = 0
local STATE_FS = 1
local STATE_GATE_FAIL = 2
local STATE_DISABLED = 3

--[[ Rudder-stick arming lives HERE, not in ArduPilot (ARMING_RUDDER must be 0).
     ArduPilot remembers an authoriser's last "passed" even after the script stops, and a
     script that never loaded (no SD card) never registers at all, so the aux-auth gate alone
     can be bypassed. Doing the stick arming in the script means: no running script, no
     stick arming. Hold right rudder with throttle low for HSK_RUD_MS to arm. ]]
--[[ PARAMETER TABLE LAYOUT IS APPEND-ONLY.
     ArduPilot stores script parameters by table slot, not by name. Inserting or reordering
     entries silently moves saved values into the wrong parameters on the next boot.
     New parameters go at the END, and slots are never reused. ]]
local LAYOUT = { "ENABLE", "FS_DLY", "CFG_HASH", "GATE", "BLOCK" }       -- slots 1-5
for n = 1, NUM_OUT do LAYOUT[#LAYOUT + 1] = "FS_PWM" .. n end              -- slots 6-21
LAYOUT[#LAYOUT + 1] = "RUD_ARM"                                           -- slot 22 (v1)
LAYOUT[#LAYOUT + 1] = "RUD_MS"                                            -- slot 23 (v1)

local defaults = { ENABLE = 1, FS_DLY = 0, CFG_HASH = 0, GATE = GATE_RC | GATE_CFG | GATE_FS, BLOCK = 0,
                   RUD_ARM = 1, RUD_MS = 2000 }
assert(param:add_table(PARAM_KEY, PREFIX, #LAYOUT), "HSK: could not add param table")
for slot, name in ipairs(LAYOUT) do
  assert(param:add_param(PARAM_KEY, slot, name, defaults[name] or 0), "HSK: could not add " .. name)
end

local P = {}
for _, name in ipairs(LAYOUT) do P[name] = Parameter(PREFIX .. name) end
local FS_PWM = {}
for n = 1, NUM_OUT do FS_PWM[n] = P["FS_PWM" .. n] end

--[[ Config hash. Must match configHash() in packages/profile (TypeScript).
     A simple position-weighted sum mod a prime below 2^24, so it fits a float param exactly. ]]
local HASH_MOD = 16777213
local function config_hash()
  local h = (P.FS_DLY:get() * 7 + P.GATE:get() * 13) % HASH_MOD
  for n = 1, NUM_OUT do
    h = (h + math.floor(FS_PWM[n]:get()) * (n * 31 + 17)) % HASH_MOD
  end
  return math.floor(h)
end

local auth_id = arming:get_aux_auth_id()
if not auth_id then gcs:send_text(3, "HSK: no aux auth slot, arming gate inactive") end

local RCMAP_YAW = Parameter("RCMAP_YAW")
local RCMAP_THROTTLE = Parameter("RCMAP_THROTTLE")
local ARMING_RUDDER = Parameter("ARMING_RUDDER")

local last_rc_ok = millis():toint()
local fs_active = false
local rud_hold_start = nil
local rud_need_release = false
local last_hb = 0
local last_gate_msg = ""

local function gate_check(now)
  if P.BLOCK:get() ~= 0 then return "test block (HSK_BLOCK)" end
  local g = math.floor(P.GATE:get())
  if (g & GATE_RC) ~= 0 and not rc:has_valid_input() then return "no RC link" end
  if (g & GATE_CFG) ~= 0 and config_hash() ~= math.floor(P.CFG_HASH:get()) then
    return "config edited by hand"
  end
  if (g & GATE_FS) ~= 0 then
    local any = false
    for n = 1, NUM_OUT do if FS_PWM[n]:get() > 0 then any = true end end
    if not any then return "failsafe pose not set" end
  end
  return nil
end

local function update()
  local now = millis():toint()
  local enabled = P.ENABLE:get() ~= 0

  -- 1. failsafe pose
  if rc:has_valid_input() then
    last_rc_ok = now
    if fs_active then fs_active = false; gcs:send_text(5, "HSK: RC back, failsafe pose released") end
  elseif enabled and (now - last_rc_ok) >= P.FS_DLY:get() then
    if not fs_active then fs_active = true; gcs:send_text(2, "HSK: RC lost, failsafe pose") end
  end
  if fs_active and enabled then
    for n = 1, NUM_OUT do
      local pwm = math.floor(FS_PWM[n]:get())
      if pwm > 0 then SRV_Channels:set_output_pwm_chan_timeout(n - 1, pwm, OVERRIDE_MS) end
    end
  end

  -- 2. arming gate
  local why = nil
  if auth_id then
    -- messages stay short: STATUSTEXT holds 50 chars and we prefix "HSK: can't arm: "
    if enabled then why = gate_check(now) else why = "disabled (HSK_ENABLE=0)" end
    if why then arming:set_aux_auth_failed(auth_id, "HSK: " .. why) else arming:set_aux_auth_passed(auth_id) end
    if why and why ~= last_gate_msg and not arming:is_armed() then gcs:send_text(4, "HSK: can't arm: " .. why) end
    last_gate_msg = why or ""
  end

  -- 2b. rudder-stick arming (only when HSK_RUD_ARM=1 and ArduPilot's own is off)
  if enabled and P.RUD_ARM:get() ~= 0 and not arming:is_armed() and rc:has_valid_input() then
    local yaw = rc:get_channel(math.floor(RCMAP_YAW:get()))
    local thr = rc:get_channel(math.floor(RCMAP_THROTTLE:get()))
    local holding = yaw and thr and yaw:norm_input() > 0.9 and thr:norm_input_ignore_trim() < -0.9
    if not holding then
      rud_hold_start = nil
      rud_need_release = false
    elseif not rud_need_release then
      if not rud_hold_start then
        rud_hold_start = now
      elseif now - rud_hold_start >= P.RUD_MS:get() then
        rud_need_release = true          -- one attempt per stick hold
        rud_hold_start = nil
        if ARMING_RUDDER:get() ~= 0 then
          gcs:send_text(4, "HSK: set ARMING_RUDDER=0")
        elseif arming:arm() then
          gcs:send_text(5, "HSK: armed by rudder")
        else
          gcs:send_text(4, "HSK: rudder arm refused")  -- ArduPilot reports why separately
        end
      end
    end
  else
    rud_hold_start = nil
  end

  -- 3. heartbeat
  if now - last_hb >= 1000 then
    last_hb = now
    local state = STATE_OK
    if not enabled then state = STATE_DISABLED elseif fs_active then state = STATE_FS elseif why then state = STATE_GATE_FAIL end
    gcs:send_named_float("HSK", state + VERSION * 100)
  end
end

-- Keep running even if one update errors: log it, back off briefly, try again.
local function protected()
  local ok, err = pcall(update)
  if not ok then
    gcs:send_text(0, "HSK error: " .. tostring(err))
    return protected, 500
  end
  return protected, LOOP_MS
end

gcs:send_text(6, string.format("HSK: husky.lua v%d running", VERSION))
return protected, LOOP_MS
