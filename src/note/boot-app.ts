import "../styles/index.css";
import "../styles.css";
import { startNoteApp } from "./note-app";
import { getConfig } from "./notes-state";
import { initializeAppearance } from "../shared/appearance";

export async function bootNoteApp(): Promise<void> {
  await getConfig();
  initializeAppearance();
  await startNoteApp();
}
