import type { Extension } from "@codemirror/state";
import { type SqlLinterConfig, sqlLinter } from "./diagnostics.js";
import { type SqlHoverConfig, sqlHover, sqlHoverTheme } from "./hover.js";
import { type SqlGutterConfig, sqlStructureGutter } from "./structure-extension.js";

export interface SqlExtensionConfig {
  enableLinting?: boolean;
  linterConfig?: SqlLinterConfig;

  enableGutterMarkers?: boolean;
  gutterConfig?: SqlGutterConfig;

  enableHover?: boolean;
  hoverConfig?: SqlHoverConfig;
}

export function sqlExtension(config: SqlExtensionConfig = {}): Extension {
  const extensions: Extension[] = [];
  const {
    enableLinting = true,
    enableGutterMarkers = true,
    enableHover = true,
    linterConfig,
    gutterConfig,
    hoverConfig,
  } = config;

  if (enableLinting) {
    extensions.push(sqlLinter(linterConfig));
  }

  if (enableGutterMarkers) {
    extensions.push(sqlStructureGutter(gutterConfig));
  }

  if (enableHover) {
    extensions.push(sqlHover(hoverConfig));
    extensions.push(sqlHoverTheme());
  }

  return extensions;
}
