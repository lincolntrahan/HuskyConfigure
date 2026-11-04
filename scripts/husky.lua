--[[
husky.lua — HuskyConfigure companion script (prototype v0.1)

Jobs:
  1. RC-loss failsafe pose: when RC has been invalid for HSK_FS_DLY ms, hold every output
     that has a non-zero HSK_FS_PWMn at that PWM. Released automatically when RC returns
     (we stop refreshing a short override timeout), and also if this script stops.
  2. Arming gate: registers as an auxiliary arming authoriser, so the vehicle can't arm
     unless this script is running and its checks pass (HSK_GATE bitmask).
  3. Heartbeat: NAMED_VALUE_FLOAT "HSK" once a second (value = state, see STATE_*).
  4. Mixer for surfaces ArduPilot can't mix natively (spoilerons, one-sided curves…). Each such
     output keeps a NATIVE fallback SERVOn_FUNCTION (e.g. Aileron for a spoileron, SERVOn_TRIM
     when nothing native fits) and the script overrides it every loop for 100 ms. If the script
     stops, the override lapses and ArduPilot's own function takes the output back.
     (A Script1..16 function would freeze the surface where it was: tested in SITL.)

All values are written by HuskyConfigure from the aircraft profile. Nobody should need to
edit them by hand. HSK_CFG_HASH lets the gate detect that someone did.
]]

local VERSION = 2           -- reported in the heartbeat; bump with any behavior change
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
LAYOUT[#LAYOUT + 1] = "MIX_N"                                             -- slot 24 (v2)
local MAX_MIX = 4
for k = 1, MAX_MIX do                                                     -- slots 25-40 (v2)
  LAYOUT[#LAYOUT + 1] = "M" .. k .. "_OUT"
  for t = 1, 3 do LAYOUT[#LAYOUT + 1] = "M" .. k .. "_T" .. t end
end

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

--[[ Mixer. A term is packed in one float by packages/profile encodeTerm():
     code = input_id * 1000 + curve * 250 + (weight * 100 + 100)
     input_id: 1 roll, 2 pitch, 3 yaw, 4 flap, 5 throttle (ArduPilot's own outputs, so they
     include stabilization), 100+N raw RC channel N (-1..1), 200+N RC channel N unipolar (0..1).
     curve: 0 linear, 1 keep positive only, 2 keep negative only. ]]
local AXIS_FN = { [1] = 4, [2] = 19, [3] = 21, [4] = 3, [5] = 70 }
local AXIS_SCALE = { [1] = 4500, [2] = 4500, [3] = 4500, [4] = 100, [5] = 100 }
local MIX_OVERRIDE_MS = 100

local function read_input(id)
  if AXIS_FN[id] then return SRV_Channels:get_output_scaled(AXIS_FN[id]) / AXIS_SCALE[id] end
  local ch = rc:get_channel(id % 100)
  if not ch then return 0 end
  if id >= 200 then return (ch:norm_input_ignore_trim() + 1) * 0.5 end
  return ch:norm_input()
end

local function term_value(code)
  if code <= 0 then return 0 end
  local id = math.floor(code / 1000)
  local rest = code - id * 1000
  local curve = math.floor(rest / 250)
  local w = (rest - curve * 250 - 100) / 100
  local x = w * read_input(id)
  if curve == 1 and x < 0 then x = 0 elseif curve == 2 and x > 0 then x = 0 end
  return x
end

local servo_params = {}  -- output number -> {min, trim, max, rev} Parameter objects
local function servo(out)
  local s = servo_params[out]
  if not s then
    local p = "SERVO" .. out .. "_"
    s = { min = Parameter(p .. "MIN"), trim = Parameter(p .. "TRIM"), max = Parameter(p .. "MAX"), rev = Parameter(p .. "REVERSED") }
    servo_params[out] = s
  end
  return s
end

local function to_pwm(out, v)
  local s = servo(out)
  if s.rev:get() ~= 0 then v = -v end
  if v > 1 then v = 1 elseif v < -1 then v = -1 end
  local trim = s.trim:get()
  if v >= 0 then return math.floor(trim + v * (s.max:get() - trim) + 0.5) end
  return math.floor(trim + v * (trim - s.min:get()) + 0.5)
end

local function run_mixer()
  local n = math.floor(P.MIX_N:get())
  if n > MAX_MIX then n = MAX_MIX end
  for k = 1, n do
    -- HSK_Mk_OUT < 0: flip the mix so it agrees with the fallback function's sign convention
    local o = math.floor(P["M" .. k .. "_OUT"]:get())
    local out, sign = math.abs(o), (o < 0) and -1 or 1
    if out >= 1 and out <= NUM_OUT then
      local v = term_value(P["M" .. k .. "_T1"]:get()) + term_value(P["M" .. k .. "_T2"]:get()) + term_value(P["M" .. k .. "_T3"]:get())
      SRV_Channels:set_output_pwm_chan_timeout(out - 1, to_pwm(out, sign * v), MIX_OVERRIDE_MS)
    end
  end
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
  else
    -- 1b. mixer (the failsafe table already holds the pose for scripted surfaces)
    run_mixer()
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
