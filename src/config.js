// Where the token server runs. Change this when you host the server somewhere else, then run `npm run build`.
export const SERVER_URL = "http://localhost:3001";

// Stop the AI session after this long without any action, to save credits.
export const IDLE_STOP_SECONDS = 90;

// Stop the AI session if the tab stays hidden this long.
export const HIDDEN_STOP_SECONDS = 20;
