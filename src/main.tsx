import React from "react";
import ReactDOM from "react-dom/client";

// Stylesheet load order matters (last wins on equal specificity):
//   1. global.css     - the design system
//   2. settings.css   - settings + context menu components
//   3. interactive.css- hover / press / focus / disabled states
//   4. App.css        - app-specific layouts and views
//   5. components.css - final shared control and panel contract
import "./design/styles/global.css";
import "./design/styles/settings.css";
import "./design/styles/interactive.css";
import "./app/App.css";
import "./design/styles/components.css";

import App from "./app/App";

ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);
