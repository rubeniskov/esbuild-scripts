/* eslint-disable @typescript-eslint/no-var-requires */
/* eslint-disable @typescript-eslint/no-unsafe-assignment */
/* eslint-disable @typescript-eslint/no-unsafe-call */
/* eslint-disable @typescript-eslint/no-unsafe-member-access */
import stripAnsi from "strip-ansi";
const ErrorOverlay = require("react-error-overlay");
const isFirstCompilation: Record<string, boolean> = {};
let isBuilding = false;
let hasCompileErrors = false;

ErrorOverlay.setEditorHandler(function editorHandler(errorLocation: { fileName: string | number | boolean; lineNumber: any; colNumber: any; }) {
  // Keep this sync with errorOverlayMiddleware.js
  void fetch(
    "/__open_editor" +
      "?fileName=" +
      window.encodeURIComponent(errorLocation.fileName) +
      "&lineNumber=" +
      window.encodeURIComponent(errorLocation.lineNumber || 1) +
      "&colNumber=" +
      window.encodeURIComponent(errorLocation.colNumber || 1)
  );
});

function clearOutdatedErrors() {
  if (!isFirstCompilation.app) {
    // Clean up outdated compile errors, if any.
    if (typeof console !== "undefined" && typeof console.clear === "function") {
      if (hasCompileErrors) {
        console.clear();
      }
    }
  }
}

ErrorOverlay.startReportingRuntimeErrors({
  filename: "/index.js",
});

const url = new URL("/_ws", window.location.href);
url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
const connection = new WebSocket(url.toString());

// Unlike WebpackDevServer client, we won't try to reconnect
// to avoid spamming the console. Disconnect usually happens
// when developer stops the server.
connection.onclose = function () {
  if (typeof console !== "undefined" && typeof console.info === "function") {
    console.info(
      "The development server has disconnected.\nRefresh the page if necessary."
    );
  }
};

interface WebSocketMessage {
  name: string;
  result: {
    warnings: string[];
    errors: string[];
  };
  building: boolean;
}

connection.onmessage = (m: MessageEvent) => {
  const message = JSON.parse(m.data) as WebSocketMessage;
  const { name, building, result } = message;

  // set whether this is the first build of this bundle
  if (isFirstCompilation[name] === undefined) {
    isFirstCompilation[name] = true;
  } else {
    isFirstCompilation[name] = false;
  }
  
  if (name === "runtime") {
    if (!isFirstCompilation[name]) {
      window.location.reload();
    }
  } else {
    isBuilding = building;

    if (isBuilding) {
      clearOutdatedErrors();
    } else {
      const isSuccessful = !isFirstCompilation[name] && result?.errors.length === 0 && result?.warnings.length === 0;
      if (isSuccessful) {
        hasCompileErrors = false;
        window.location.reload();
        
      } else {
        hasCompileErrors = true;
        clearOutdatedErrors();

        const formatted = result;

        if (
          typeof console !== "undefined" &&
          typeof console.warn === "function"
        ) {
          for (let i = 0; i < formatted.warnings.length; i++) {
            if (i === 5) {
              console.warn(
                "There were more warnings in other files.\n" +
                  "You can find a complete log in the terminal."
              );
              break;
            }
            console.warn(stripAnsi(formatted.warnings[i]));
          }
        }

        if (
          typeof console !== "undefined" &&
          typeof console.error === "function"
        ) {
          for (let i = 0; i < formatted.errors.length; i++) {
            console.error(stripAnsi(formatted.errors[i]));
          }
        }

        ErrorOverlay.reportBuildError(formatted.errors[0]);
      }
    }
  }
};
