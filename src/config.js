// Where the token server runs. For a hosted server build with: SERVER_URL=https://your-server npm run build
// eslint-disable-next-line no-undef
export const SERVER_URL = (typeof __SERVER_URL__ !== "undefined" && __SERVER_URL__) || "http://localhost:3001";

// Stop the AI session after this long without any action, to save credits.
export const IDLE_STOP_SECONDS = 90;

// Stop the AI session if the tab stays hidden this long.
export const HIDDEN_STOP_SECONDS = 20;
