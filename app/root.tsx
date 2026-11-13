import {
  Links,
  Meta,
  Outlet,
  Scripts,
  ScrollRestoration,
  useRouteError,
  isRouteErrorResponse,
} from "@remix-run/react";
import type { LinksFunction, MetaFunction } from "@remix-run/node";

import tokensStyles from "~/styles/tokens.css?url";
import desktopStyles from "~/styles/desktop.css?url";
import chatStyles from "~/styles/chat.css?url";
import { action as indexAction } from "~/routes/_index";

export const action = indexAction;

export const meta: MetaFunction = () => {
  return [
    { title: "FredBot OS | PersonaBot Tech (IFFarroupilha)" },
    {
      name: "description",
      content:
        "Clone Digital Conversacional autônomo do Frederico com Function Calling no SQLite e Google Gemini AI Studio.",
    },
    { name: "viewport", content: "width=device-width, initial-scale=1" },
  ];
};

export const links: LinksFunction = () => [
  { rel: "preconnect", href: "https://fonts.googleapis.com" },
  {
    rel: "preconnect",
    href: "https://fonts.gstatic.com",
    crossOrigin: "anonymous",
  },
  {
    rel: "stylesheet",
    href: "https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700&family=JetBrains+Mono:wght@400;600;700&family=Outfit:wght@500;600;700;800&display=swap",
  },
  { rel: "stylesheet", href: tokensStyles },
  { rel: "stylesheet", href: desktopStyles },
  { rel: "stylesheet", href: chatStyles },
  {
    rel: "icon",
    type: "image/svg+xml",
    href: "data:image/svg+xml,<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 100 100'><text y='.9em' font-size='90'>🧢</text></svg>",
  },
];

export default function App() {
  return (
    <html lang="pt-BR">
      <head>
        <meta charSet="utf-8" />
        <Meta />
        <Links />
      </head>
      <body>
        <Outlet />
        <ScrollRestoration />
        <Scripts />
      </body>
    </html>
  );
}

export function ErrorBoundary() {
  const error = useRouteError();
  const message = isRouteErrorResponse(error)
    ? `${error.status} — ${error.statusText}`
    : error instanceof Error
      ? error.message
      : "Erro inesperado no FredOS.";

  return (
    <html lang="pt-BR">
      <head>
        <meta charSet="utf-8" />
        <Meta />
        <Links />
      </head>
      <body style={{ padding: "40px 20px", fontFamily: "sans-serif" }}>
        <div className="retro-window" style={{ maxWidth: "640px", margin: "0 auto" }}>
          <div className="window-header blue">
            <div className="window-title">⚠️ FredOS — Erro Crítico</div>
          </div>
          <div style={{ padding: "20px" }}>
            <p>Não foi possível carregar a aplicação no momento:</p>
            <pre style={{ background: "#0f172a", color: "#f87171", padding: "12px", borderRadius: "6px" }}>
              {message}
            </pre>
            <a href="/" className="btn-send" style={{ textDecoration: "none", display: "inline-block", marginTop: "12px" }}>
              Voltar ao início ↻
            </a>
          </div>
        </div>
        <Scripts />
      </body>
    </html>
  );
}
