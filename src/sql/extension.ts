import type { Extension } from "@codemirror/state";
import { type SqlLinterConfig, sqlLinter } from "./diagnostics.js";
import { type SqlGutterConfig, sqlStructureGutter } from "./structure-extension.js";

export interface SqlExtensionConfig extends SqlLinterConfig, SqlGutterConfig {
  enableLinting?: boolean;
  enableStructureAnalysis?: boolean;
  enableGutterMarkers?: boolean;
}

export function sqlExtension(config: SqlExtensionConfig = {}): Extension {
  const extensions: Extension[] = [];

  if (config.enableLinting !== false) {
    extensions.push(sqlLinter(config));
  }

  if (config.enableStructureAnalysis !== false && config.enableGutterMarkers !== false) {
    extensions.push(sqlStructureGutter(config));
  }

  return extensions;
}
