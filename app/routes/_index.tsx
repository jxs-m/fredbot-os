import { useState, useRef, useEffect } from "react";
import { json, type ActionFunctionArgs, type LoaderFunctionArgs } from "@remix-run/node";
import { useLoaderData, useFetcher, useRouteError, isRouteErrorResponse } from "@remix-run/react";
import { getDashboardData, confirmarCompromisso, alternarRecadoLido } from "~/services/db.server";
import { askFredBot } from "~/services/gemini.server";
import { checkRateLimit, getClientIdentifier } from "~/services/rateLimit.server";
import type { ChatMessage, ToolCallExecution, DashboardData } from "~/types";

const MAX_MESSAGE_LENGTH = 1000;

export async function loader({ request }: LoaderFunctionArgs) {
  const dashboard = getDashboardData();
  const hasGeminiKey = Boolean(process.env.GEMINI_API_KEY && process.env.GEMINI_API_KEY.trim() !== "");
  return json({
    dashboard,
    hasGeminiKey,
  });
}

export async function action({ request }: ActionFunctionArgs) {
  try {
    const formData = await request.formData();
    const intent = formData.get("intent")?.toString() || "chat";

    if (intent === "confirm_agenda") {
      const id = Number(formData.get("id"));
      if (!confirmarCompromisso(id)) {
        return json({ error: "Compromisso não encontrado para confirmação.", dashboard: getDashboardData() }, { status: 400 });
      }
      return json({ ok: true, dashboard: getDashboardData() });
    }

    if (intent === "toggle_recado") {
      const id = Number(formData.get("id"));
      if (!alternarRecadoLido(id)) {
        return json({ error: "Recado não encontrado para atualização.", dashboard: getDashboardData() }, { status: 400 });
      }
      return json({ ok: true, dashboard: getDashboardData() });
    }

    const clientId = getClientIdentifier(request);
    const rateCheck = checkRateLimit(clientId);
    if (!rateCheck.allowed) {
      return json(
        {
          error: `Calma lá! Muitas mensagens em sequência (controle de requisições). Tenta de novo em ${rateCheck.retryAfterSeconds}s.`,
          dashboard: getDashboardData(),
        },
        { status: 429 }
      );
    }

    const message = formData.get("message")?.toString() || "";
    const historyRaw = formData.get("history")?.toString() || "[]";

    if (!message.trim()) {
      return json({ error: "Mensagem vazia — escreve alguma coisa aí!", dashboard: getDashboardData() }, { status: 400 });
    }

    if (message.trim().length > MAX_MESSAGE_LENGTH) {
      return json(
        { error: `Mensagem muito longa (máximo de ${MAX_MESSAGE_LENGTH} caracteres).`, dashboard: getDashboardData() },
        { status: 400 }
      );
    }

    let chatHistory: Array<{ role: "user" | "model"; parts: string }> = [];
    try {
      const parsed = JSON.parse(historyRaw);
      chatHistory = Array.isArray(parsed) ? parsed : [];
    } catch {
      chatHistory = [];
    }

    const result = await askFredBot(message, chatHistory);
    const updatedDashboard = getDashboardData();

    return json({
      reply: result.reply,
      toolCalls: result.toolCalls,
      dashboard: updatedDashboard,
    });
  } catch (error) {
    console.error("[FredBot Action Error]:", error);
    return json(
      {
        error: `Erro interno ao processar requisição: ${(error as Error).message}`,
        toolCalls: [],
        dashboard: getDashboardData(),
      },
      { status: 500 }
    );
  }
}

export default function Index() {
  const { dashboard: initialDashboard, hasGeminiKey } = useLoaderData<typeof loader>();
  const fetcher = useFetcher<typeof action>();
  const dashboardFetcher = useFetcher<typeof action>();

  const [dashboard, setDashboard] = useState<DashboardData>(initialDashboard);
  const [inputText, setInputText] = useState("");
  const [messages, setMessages] = useState<ChatMessage[]>([
    {
      id: "initial-1",
      sender: "fred_ia",
      authorName: "Fred IA (Gêmeo Digital)",
      text: "Fala gurizada! Aqui é o Fred IA. O Frederico real tá atolado de código e trabalhos do IFFarroupilha e não vai responder ninguém, mas eu tô 100% no comando. Podem consultar minha agenda, marcar os rolês, deixar recados urgentes ou mandar /ajuda pros comandos rápidos!",
      timestamp: new Date().toLocaleTimeString("pt-BR", { hour: "2-digit", minute: "2-digit" }),
    },
  ]);
  const [liveToolLogs, setLiveToolLogs] = useState<ToolCallExecution[]>([
    {
      name: "systemInit",
      args: { database: "fredbot.db", engine: "SQLite Native (Node 24)", mode: "Híbrido (Regras + Gemini)" },
      result: { status: "ready", initialEvents: initialDashboard.agenda.length },
      timestamp: new Date().toLocaleTimeString("pt-BR"),
    },
  ]);

  const messagesEndRef = useRef<HTMLDivElement>(null);
  const wasSubmittingRef = useRef(false);
  const [currentTime, setCurrentTime] = useState("");

  useEffect(() => {
    setCurrentTime(new Date().toLocaleTimeString("pt-BR", { hour: "2-digit", minute: "2-digit" }));
    const timer = setInterval(() => {
      setCurrentTime(new Date().toLocaleTimeString("pt-BR", { hour: "2-digit", minute: "2-digit" }));
    }, 10000);
    return () => clearInterval(timer);
  }, []);

  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages, fetcher.state]);

  // Atualizar mensagens e dashboard quando a action do chat responder
  useEffect(() => {
    if (fetcher.state !== "idle") {
      wasSubmittingRef.current = true;
      return;
    }

    if (!wasSubmittingRef.current) return;
    wasSubmittingRef.current = false;

    const data = fetcher.data;
    if (!data) {
      setMessages((prev) => [
        ...prev,
        {
          id: `err-${Date.now()}`,
          sender: "fred_ia",
          authorName: "Fred IA (Aviso de Conexão)",
          text: "⚠️ Falha ao comunicar com o servidor local. Confere se o servidor está rodando e tenta de novo!",
          timestamp: new Date().toLocaleTimeString("pt-BR", { hour: "2-digit", minute: "2-digit" }),
        },
      ]);
      return;
    }

    if ("reply" in data && data.reply) {
      const toolCalls = "toolCalls" in data && Array.isArray(data.toolCalls) ? data.toolCalls : [];
      const botMsg: ChatMessage = {
        id: `msg-${Date.now()}`,
        sender: "fred_ia",
        authorName: "Fred IA (Gêmeo Digital)",
        text: data.reply,
        toolCalls,
        timestamp: new Date().toLocaleTimeString("pt-BR", { hour: "2-digit", minute: "2-digit" }),
      };
      setMessages((prev) => [...prev, botMsg]);

      if (toolCalls.length > 0) {
        setLiveToolLogs((prev) => [...prev, ...toolCalls]);
      }
    } else if ("error" in data && data.error) {
      const errMsg: ChatMessage = {
        id: `err-${Date.now()}`,
        sender: "fred_ia",
        authorName: "Fred IA (Aviso)",
        text: `⚠️ ${data.error}`,
        timestamp: new Date().toLocaleTimeString("pt-BR", { hour: "2-digit", minute: "2-digit" }),
      };
      setMessages((prev) => [...prev, errMsg]);
    }

    if ("dashboard" in data && data.dashboard) {
      setDashboard(data.dashboard);
    }
  }, [fetcher.data, fetcher.state]);

  // Atualizar dashboard após confirmações manuais na Central do Fred
  useEffect(() => {
    if (dashboardFetcher.state === "idle" && dashboardFetcher.data && "dashboard" in dashboardFetcher.data && dashboardFetcher.data.dashboard) {
      setDashboard(dashboardFetcher.data.dashboard);
    }
  }, [dashboardFetcher.data, dashboardFetcher.state]);

  const sendMessageText = (rawText: string) => {
    const text = rawText.trim();
    if (!text || fetcher.state !== "idle") return;

    const userMsg: ChatMessage = {
      id: `user-${Date.now()}`,
      sender: "user",
      authorName: "Você (Turma de IA)",
      text,
      timestamp: new Date().toLocaleTimeString("pt-BR", { hour: "2-digit", minute: "2-digit" }),
    };

    setMessages((prev) => [...prev, userMsg]);
    setInputText("");

    // Montar histórico simplificado para Gemini
    // O Gemini API exige estritamente que o histórico de chat comece com role: 'user'.
    const userMessageIdx = messages.findIndex((m) => m.sender === "user");
    const validHistoryCandidates = userMessageIdx !== -1 ? messages.slice(userMessageIdx) : [];

    const historyPayload = validHistoryCandidates
      .slice(-6)
      .map((m) => ({
        role: m.sender === "user" ? ("user" as const) : ("model" as const),
        parts: m.text,
      }));

    fetcher.submit(
      {
        intent: "chat",
        message: text,
        history: JSON.stringify(historyPayload),
      },
      { method: "post", action: "/?index" }
    );
  };

  const handleSendMessage = () => sendMessageText(inputText);

  const isSubmitting = fetcher.state !== "idle";

  return (
    <div style={{ display: "flex", flexDirection: "column", minHeight: "100vh" }}>
      {/* Barra de Sistema FredOS */}
      <header className="fredos-topbar">
        <div className="topbar-brand">
          <span className="brand-icon">⚡</span>
          <span className="brand-name">FredOS v2.4</span>
          <span className="topbar-subtitle">PersonaBot Tech • IFFarroupilha</span>
        </div>
        <div className="topbar-info">
          <span className={`mode-badge ${hasGeminiKey ? "gemini" : "offline"}`}>
            ● {hasGeminiKey ? "Google Gemini API Ativa" : "Chave da API Ausente"}
          </span>
          <span className="topbar-clock">{currentTime || "10:00"}</span>
        </div>
      </header>

      {/* Área Desktop com as 3 Janelas */}
      <main className="desktop-workspace">
        {/* JANELA 1: Chat da Turma com Fred IA */}
        <section className="retro-window chat-window" aria-label="Chat com Fred IA">
          <div className="window-header blue">
            <div className="window-controls">
              <span className="control-dot close" />
              <span className="control-dot minimize" />
              <span className="control-dot maximize" />
            </div>
            <div className="window-title">
              <span>🤖 FredBot — Gêmeo Digital</span>
              <span className="window-status-pill">100% Autônomo</span>
            </div>
            <span style={{ fontSize: "0.8rem", opacity: 0.9 }}>IFFarroupilha</span>
          </div>

          <div className="chat-body">
            {/* Feed de Mensagens */}
            <div className="chat-messages">
              {messages.map((msg) => (
                <div key={msg.id} className={`message-row ${msg.sender}`}>
                  <div className="message-avatar">
                    {msg.sender === "fred_ia" ? "🧢" : "👤"}
                  </div>
                  <div className="message-bubble-wrapper">
                    <span className="message-author">{msg.authorName}</span>
                    <div className="message-bubble">{msg.text}</div>
                    <div className="message-meta">
                      <span>{msg.timestamp}</span>
                      {msg.toolCalls && msg.toolCalls.length > 0 && (
                        <span className="tools-badge">
                          ⚙️ {msg.toolCalls.length} tool(s) executada(s)
                        </span>
                      )}
                    </div>
                  </div>
                </div>
              ))}

              {isSubmitting && (
                <div className="message-row fred_ia">
                  <div className="message-avatar">🧢</div>
                  <div className="message-bubble-wrapper">
                    <span className="message-author">Fred IA</span>
                    <div className="typing-indicator">
                      <span>Fred IA consultando SQLite...</span>
                      <div className="typing-dot" />
                      <div className="typing-dot" />
                      <div className="typing-dot" />
                    </div>
                  </div>
                </div>
              )}
              <div ref={messagesEndRef} />
            </div>

            {/* Atalhos Rápidos (Regras Locais + Testes de IA) */}
            <div className="quick-chips" aria-label="Comandos rápidos">
              <button
                type="button"
                className="quick-chip rule"
                disabled={isSubmitting}
                onClick={() => sendMessageText("/ajuda")}
                title="Regra local instantânea (não usa API)"
              >
                ⚡ /ajuda
              </button>
              <button
                type="button"
                className="quick-chip rule"
                disabled={isSubmitting}
                onClick={() => sendMessageText("/agenda")}
                title="Lista agenda direto do SQLite"
              >
                📅 /agenda
              </button>
              <button
                type="button"
                className="quick-chip rule"
                disabled={isSubmitting}
                onClick={() => sendMessageText("/recados")}
                title="Lista recados direto do SQLite"
              >
                📌 /recados
              </button>
              <button
                type="button"
                className="quick-chip ai"
                disabled={isSubmitting}
                onClick={() => sendMessageText("E aí Dani, bora ensaiar quinta-feira às 18h?")}
              >
                🎸 Testar Agenda IA
              </button>
            </div>

            {/* Formulário de Envio Livre */}
            <form
              className="chat-form"
              onSubmit={(e) => {
                e.preventDefault();
                handleSendMessage();
              }}
            >
              <input
                type="text"
                className="chat-input"
                maxLength={MAX_MESSAGE_LENGTH}
                placeholder="Fale com o Fred IA (ou digite /ajuda, /agenda, /recados)..."
                value={inputText}
                onChange={(e) => setInputText(e.target.value)}
                disabled={isSubmitting}
              />
              <button
                type="submit"
                className="btn-send"
                disabled={isSubmitting || !inputText.trim()}
              >
                Enviar ⚡
              </button>
            </form>
          </div>
        </section>

        {/* JANELA 2: Central do Fred (Persistência SQLite Interativa) */}
        <section className="retro-window central-fred-window" aria-label="Central do Fred">
          <div className="window-header yellow">
            <div className="window-controls">
              <span className="control-dot close" />
              <span className="control-dot minimize" />
              <span className="control-dot maximize" />
            </div>
            <div className="window-title">
              <span>📋 Central do Fred (SQLite Sync)</span>
            </div>
            <span style={{ fontSize: "0.75rem", fontWeight: 700 }}>
              {dashboard.agenda.length} Eventos • {dashboard.recados.length} Recados
            </span>
          </div>

          <div className="central-body">
            {/* Seção Agenda */}
            <div>
              <div className="central-section-title">
                <span>📅 Agenda de Compromissos</span>
                <span style={{ color: "var(--primary-blue)" }}>{dashboard.agenda.length} ativos</span>
              </div>
              <div className="agenda-list">
                {dashboard.agenda.map((ev) => (
                  <div key={ev.id ?? `${ev.data}-${ev.hora}`} className="agenda-card">
                    <div className="agenda-card-header">
                      <span className="agenda-time">
                        {ev.data} às {ev.hora}
                      </span>
                      <span className={`status-badge ${ev.status}`}>
                        {ev.status === "confirmado" ? "Confirmado" : "Pendente"}
                      </span>
                    </div>
                    <div className="agenda-title">{ev.titulo}</div>
                    <div className="agenda-footer-row">
                      <div className="agenda-solicitante">
                        Por: <strong>{ev.solicitante}</strong>
                      </div>
                      {ev.id && ev.status !== "confirmado" && (
                        <button
                          type="button"
                          className="mini-action-btn confirm"
                          disabled={dashboardFetcher.state !== "idle"}
                          onClick={() =>
                            dashboardFetcher.submit(
                              { intent: "confirm_agenda", id: String(ev.id) },
                              { method: "post", action: "/?index" }
                            )
                          }
                        >
                          ✓ Confirmar
                        </button>
                      )}
                    </div>
                  </div>
                ))}
              </div>
            </div>

            {/* Seção Recados */}
            <div>
              <div className="central-section-title">
                <span>📌 Recados Salvos no SQLite</span>
                <span style={{ color: "var(--accent-yellow)" }}>{dashboard.recados.length} notas</span>
              </div>
              <div className="recados-list">
                {dashboard.recados.map((rec) => (
                  <div
                    key={rec.id ?? rec.criadoEm}
                    className={`recado-card ${rec.prioridade} ${rec.lido ? "lido" : ""}`}
                  >
                    <div className="recado-header">
                      <span className="recado-autor">👤 {rec.nomeAmigo}</span>
                      <span className={`badge-${rec.prioridade}`}>
                        {rec.prioridade === "urgente" ? "URGENTE" : "Normal"}
                      </span>
                    </div>
                    <p className="recado-texto">{rec.mensagem}</p>
                    <div className="recado-footer-row">
                      <span className="recado-data">🕒 {rec.criadoEm}</span>
                      {rec.id && (
                        <button
                          type="button"
                          className="mini-action-btn"
                          disabled={dashboardFetcher.state !== "idle"}
                          onClick={() =>
                            dashboardFetcher.submit(
                              { intent: "toggle_recado", id: String(rec.id) },
                              { method: "post", action: "/?index" }
                            )
                          }
                        >
                          {rec.lido ? "✓ Lido" : "Marcar lido"}
                        </button>
                      )}
                    </div>
                  </div>
                ))}
              </div>
            </div>
          </div>
        </section>

        {/* JANELA 3: Inspetor de Function Calling (Live Terminal) */}
        <section className="retro-window inspector-window" aria-label="Inspetor de Function Calling">
          <div className="window-header dark">
            <div className="window-controls">
              <span className="control-dot close" />
              <span className="control-dot minimize" />
              <span className="control-dot maximize" />
            </div>
            <div className="window-title">
              <span style={{ color: "var(--terminal-green)" }}>💻 Live Inspector: Regras, Tools &amp; SQLite</span>
            </div>
            <span style={{ fontSize: "0.75rem", color: "#94a3b8" }}>Terminal Monitor</span>
          </div>

          <div className="inspector-body">
            {liveToolLogs.map((log, idx) => (
              <div key={idx} className="terminal-line call">
                <span style={{ color: "var(--terminal-yellow)" }}>[{log.timestamp}]</span>{" "}
                <strong style={{ color: "var(--terminal-cyan)" }}>&gt;&gt; CALL:</strong> {log.name}(
                {JSON.stringify(log.args)})<br />
                <span style={{ color: "var(--terminal-green)", paddingLeft: "16px", display: "inline-block" }}>
                  &lt;&lt; RESULT: {JSON.stringify(log.result)}
                </span>
              </div>
            ))}
            <div className="terminal-line idle">
              &gt; [FredOS System] Pronto para interceptar regras locais e chamadas de ferramentas...
            </div>
          </div>
        </section>
      </main>

      {/* Rodapé Acadêmico */}
      <footer className="academic-footer">
        Trabalho de <strong>Desenvolvimento de Inteligência Artificial</strong> — Prof.{" "}
        <strong>Luiz Rafael Jacques Caldeira</strong> (IFFarroupilha)
        <br />
        Equipe: <strong>Murilo Jaques</strong>, <strong>Daniel Guerra</strong> e <strong>João Vitor</strong> • Empresa:{" "}
        <strong>PersonaBot Tech (FredIA)</strong>
      </footer>
    </div>
  );
}

export function ErrorBoundary() {
  const error = useRouteError();
  const message = isRouteErrorResponse(error)
    ? `${error.status} — ${error.statusText}`
    : error instanceof Error
      ? error.message
      : "Erro inesperado no sistema.";

  return (
    <div style={{ padding: "40px 20px", maxWidth: "680px", margin: "0 auto" }}>
      <div className="retro-window">
        <div className="window-header blue">
          <div className="window-title">⚠️ FredOS — Recuperação de Erro</div>
        </div>
        <div style={{ padding: "20px", display: "flex", flexDirection: "column", gap: "12px" }}>
          <p style={{ margin: 0, fontWeight: 600 }}>
            Opa, deu algum tilt inesperado aqui no FredOS!
          </p>
          <pre
            style={{
              margin: 0,
              padding: "12px",
              background: "#0f172a",
              color: "#f87171",
              borderRadius: "6px",
              overflowX: "auto",
              fontSize: "0.85rem",
            }}
          >
            {message}
          </pre>
          <div>
            <a href="/" className="btn-send" style={{ textDecoration: "none" }}>
              Recarregar FredOS ↻
            </a>
          </div>
        </div>
      </div>
    </div>
  );
}
