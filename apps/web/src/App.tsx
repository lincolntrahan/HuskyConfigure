import { useEffect, useState } from "react";
import { useSession } from "./state.ts";
import { StatusBar } from "./components/StatusBar.tsx";
import { ConnectPage } from "./pages/ConnectPage.tsx";
import { OverviewPage } from "./pages/OverviewPage.tsx";
import { ParamsPage } from "./pages/ParamsPage.tsx";
import { BackupsPage } from "./pages/BackupsPage.tsx";
import { WizardPage } from "./wizard/WizardPage.tsx";

type Page = "connect" | "overview" | "setup" | "params" | "backups";

const NAV: { id: Page; label: string; needsVehicle: boolean; soon?: boolean }[] = [
  { id: "connect", label: "Connect", needsVehicle: false },
  { id: "overview", label: "Overview", needsVehicle: true },
  { id: "setup", label: "Setup wizard", needsVehicle: true },
  { id: "params", label: "Parameters", needsVehicle: true },
  { id: "backups", label: "Backups", needsVehicle: true },
];

export function App() {
  const s = useSession();
  const [page, setPage] = useState<Page>("connect");
  // keep pages up through a reboot/reconnect (phase goes back through "connecting")
  const haveVehicle = !!s.info && s.phase !== "disconnected" && s.phase !== "error";

  // Jump to the overview once connected; back to connect if the link goes away.
  useEffect(() => {
    if (s.phase === "ready" && page === "connect") setPage("setup");
    if ((s.phase === "disconnected" || s.phase === "error") && !s.busy) setPage("connect");
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [s.phase]);

  return (
    <div className="app">
      <StatusBar />
      <div className="body">
        <nav className="nav">
          <div className="brand">HuskyConfigure</div>
          {NAV.map((n) => (
            <button key={n.id} className={`nav-item ${page === n.id ? "active" : ""}`}
              disabled={(n.needsVehicle && !haveVehicle) || n.soon}
              onClick={() => setPage(n.id)}>
              {n.label}{n.soon && <span className="soon">next</span>}
            </button>
          ))}
        </nav>
        <main className="main">
          {page === "connect" && <ConnectPage />}
          {page === "overview" && haveVehicle && <OverviewPage />}
          {page === "setup" && haveVehicle && <WizardPage />}
          {page === "params" && haveVehicle && <ParamsPage />}
          {page === "backups" && haveVehicle && <BackupsPage />}
        </main>
      </div>
    </div>
  );
}
