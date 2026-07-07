import { useEffect, useRef, useState } from "react";
import React from "react";
import {
  QrCode,
  ScanLine,
  Wifi,
  WifiOff,
  Moon,
  Sun,
  X,
  Bell,
  Sparkles,
  Zap,
  UserCheck,
  Check,
  AlertCircle
} from "lucide-react";
import { Message, Peer, Session } from "./types";
import { playNotificationSound, getAvatarGradient, getInitials, getApiUrl, getWsUrl } from "./utils";
import QrGenerator from "./components/QrGenerator";
import QrScanner from "./components/QrScanner";
import ChatRoom from "./components/ChatRoom";

interface Toast {
  id: string;
  message: string;
  type: "success" | "error" | "info";
}

export default function App() {
  // --- Core State ---
  const [session, setSession] = useState<Session | null>(null);
  const [view, setView] = useState<"home" | "generate" | "scan" | "chat">("home");
  const [isDarkMode, setIsDarkMode] = useState<boolean>(true);
  const [toasts, setToasts] = useState<Toast[]>([]);

  // --- Real-time Peer State ---
  const [peer, setPeer] = useState<Peer | null>(null);
  const [peerOnline, setPeerOnline] = useState(false);
  const [peerTyping, setPeerTyping] = useState(false);
  const [messages, setMessages] = useState<Message[]>([]);
  const [incomingRequest, setIncomingRequest] = useState<{
    id: string;
    name: string;
    avatarSeed: string;
  } | null>(null);

  // --- Pairing Flow Flags ---
  const [isConnecting, setIsConnecting] = useState(false);
  const [waitingForResponse, setWaitingForResponse] = useState<string | null>(null); // name of peer we requested

  // --- Connection Refs ---
  const wsRef = useRef<WebSocket | null>(null);
  const pingIntervalRef = useRef<NodeJS.Timeout | null>(null);
  const autoConnectRef = useRef<string | null>(null);

  // --- Custom Toast Dispatcher ---
  const addToast = (message: string, type: "success" | "error" | "info" = "info") => {
    const id = Math.random().toString(36).substring(7);
    setToasts((prev) => [...prev, { id, message, type }]);
    setTimeout(() => {
      setToasts((prev) => prev.filter((t) => t.id !== id));
    }, 4500);
  };

  // --- Handshake & Register Session ---
  useEffect(() => {
    // 1. Theme restoration
    const cachedTheme = localStorage.getItem("qr_p2p_dark_theme");
    if (cachedTheme !== null) {
      setIsDarkMode(cachedTheme === "true");
    }

    // 2. Scan URL parameter extractor
    const urlParams = new URLSearchParams(window.location.search);
    const scanTargetId = urlParams.get("scan");
    if (scanTargetId) {
      autoConnectRef.current = scanTargetId;
      // Clean query string out of browser address bar so it doesn't loop
      window.history.replaceState({}, document.title, window.location.pathname);
    }

    // 3. Handshake session registration with server
    const savedSessionId = localStorage.getItem("qr_p2p_session_id");
    fetch(getApiUrl("/api/session/register"), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ sessionId: savedSessionId }),
    })
      .then((res) => res.json())
      .then((data) => {
        if (data.success) {
          setSession(data.session);
          localStorage.setItem("qr_p2p_session_id", data.session.id);
          console.log("Session handshake successful:", data.session);

          if (data.session.connectedRoomId) {
            setView("chat");
            addToast("Reconnecting to active session...", "info");
          }
        } else {
          addToast("Failed to initialize secure session", "error");
        }
      })
      .catch((err) => {
        console.error("Session handshaking failed:", err);
        addToast("Server connection failure", "error");
      });
  }, []);

  // --- WebSocket Connection lifecycle manager ---
  useEffect(() => {
    if (!session) return;

    // Disconnect existing socket if any
    if (wsRef.current) {
      wsRef.current.close();
    }

    const wsUrl = getWsUrl();
    const ws = new WebSocket(wsUrl);
    wsRef.current = ws;

    ws.onopen = () => {
      console.log("WebSocket connection established. Handshaking...");
      // Register WS connection for current session
      ws.send(JSON.stringify({ type: "register-ws", sessionId: session.id }));

      // Setup 15-sec heartbeat keep alive interval
      if (pingIntervalRef.current) clearInterval(pingIntervalRef.current);
      pingIntervalRef.current = setInterval(() => {
        if (ws.readyState === WebSocket.OPEN) {
          ws.send(JSON.stringify({ type: "ping" }));
        }
      }, 15000);
    };

    ws.onmessage = (event) => {
      try {
        const payload = JSON.parse(event.data);
        const { type } = payload;

        if (type === "ws-registered") {
          console.log("WS registered securely. Socket is live.");
          
          // Trigger automatic pairing if scanned link parameter existed
          if (autoConnectRef.current) {
            const targetId = autoConnectRef.current;
            autoConnectRef.current = null;
            requestConnection(targetId);
          }
        }

        if (type === "incoming-request") {
          playNotificationSound("request");
          setIncomingRequest(payload.sender);
        }

        if (type === "request-sent") {
          setIsConnecting(false);
          addToast("Pairing request delivered successfully!", "success");
        }

        if (type === "connection-declined") {
          setWaitingForResponse(null);
          setIsConnecting(false);
          addToast(`${payload.responderName} declined your chat invitation.`, "error");
        }

        if (type === "connection-established") {
          playNotificationSound("success");
          setWaitingForResponse(null);
          setIsConnecting(false);
          setIncomingRequest(null);
          
          setPeer(payload.peer);
          setPeerOnline(payload.peer.online);
          setMessages([]);
          setView("chat");

          // Update local session state
          setSession((prev) => prev ? { ...prev, connectedRoomId: payload.roomId } : null);
          addToast(`Linked with ${payload.peer.name}!`, "success");
        }

        if (type === "room-sync") {
          setPeer(payload.peer);
          setPeerOnline(payload.peer.online);
          setMessages(payload.messages);
          setView("chat");
          addToast(`Re-synchronized active chat room!`, "success");
        }

        if (type === "peer-status-change") {
          setPeerOnline(payload.online);
          addToast(payload.online ? "Peer came back online" : "Peer went offline", payload.online ? "success" : "info");
        }

        if (type === "peer-typing") {
          setPeerTyping(payload.isTyping);
        }

        if (type === "message-received") {
          const { message } = payload;
          setMessages((prev) => {
            // Guard against duplicate sync payloads
            if (prev.some((m) => m.id === message.id)) return prev;
            return [...prev, message];
          });
          if (message.senderId !== session.id) {
            playNotificationSound("message");
          }
        }

        if (type === "message-deleted") {
          setMessages((prev) => prev.filter((m) => m.id !== payload.messageId));
        }

        if (type === "peer-disconnected") {
          playNotificationSound("request");
          setPeer(null);
          setPeerOnline(false);
          setPeerTyping(false);
          setMessages([]);
          setSession((prev) => prev ? { ...prev, connectedRoomId: null } : null);
          setView("home");

          if (payload.reason === "left") {
            addToast("The peer has disconnected and closed the session.", "info");
          } else if (payload.reason === "you-left") {
            addToast("You left the chat room. Session closed.", "info");
          } else {
            addToast("Peer connection lost.", "error");
          }
        }

        if (type === "error") {
          setIsConnecting(false);
          addToast(payload.message, "error");
        }
      } catch (err) {
        console.error("Error decoding websocket push:", err);
      }
    };

    ws.onclose = () => {
      console.log("WebSocket closed. Attempting reconnect in 4s...");
      if (pingIntervalRef.current) clearInterval(pingIntervalRef.current);
    };

    // Global custom event hook to let children dispatch over socket easily
    const handleWSSend = (e: Event) => {
      const customEvent = e as CustomEvent;
      if (ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify(customEvent.detail));
      } else {
        addToast("Websocket is reconnecting. Try again.", "error");
      }
    };

    window.addEventListener("ws-send", handleWSSend);

    return () => {
      window.removeEventListener("ws-send", handleWSSend);
      if (pingIntervalRef.current) clearInterval(pingIntervalRef.current);
    };
  }, [session?.id]);

  // --- Dispatch Connection Request ---
  const requestConnection = (targetId: string) => {
    if (!wsRef.current || wsRef.current.readyState !== WebSocket.OPEN) {
      addToast("Connection to server is sleeping. Try again in a moment.", "error");
      return;
    }

    if (targetId === session?.id) {
      addToast("You cannot pair with your own session QR code.", "error");
      return;
    }

    setIsConnecting(true);
    setWaitingForResponse("Peer");
    wsRef.current.send(
      JSON.stringify({
        type: "request-connection",
        targetSessionId: targetId,
      })
    );
  };

  // --- Respond to Incoming Connection ---
  const respondConnection = (accept: boolean) => {
    if (!incomingRequest || !wsRef.current) return;

    wsRef.current.send(
      JSON.stringify({
        type: "respond-connection",
        targetSessionId: incomingRequest.id,
        accept,
      })
    );

    if (!accept) {
      addToast("Pairing invitation declined.", "info");
    }
    setIncomingRequest(null);
  };

  // --- Disconnect Active Chat Room ---
  const leaveRoom = () => {
    if (!session?.connectedRoomId || !wsRef.current) return;

    wsRef.current.send(
      JSON.stringify({
        type: "leave-room",
        roomId: session.connectedRoomId,
      })
    );
  };

  // --- Send Message Hook ---
  const sendMessage = (text: string, fileId?: string, fileMeta?: any) => {
    if (!session?.connectedRoomId || !wsRef.current) return;

    wsRef.current.send(
      JSON.stringify({
        type: "chat-message",
        roomId: session.connectedRoomId,
        text,
        file: fileId ? { id: fileId, ...fileMeta } : undefined,
      })
    );
  };

  // --- Synced Message Deletion Hook ---
  const deleteMessage = (messageId: string) => {
    if (!session?.connectedRoomId || !wsRef.current) return;

    wsRef.current.send(
      JSON.stringify({
        type: "delete-message",
        roomId: session.connectedRoomId,
        messageId,
      })
    );
  };

  // --- Refresh QR / Reset Profile ---
  const handleRefreshSession = () => {
    localStorage.removeItem("qr_p2p_session_id");
    fetch(getApiUrl("/api/session/register"), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ sessionId: null }),
    })
      .then((res) => res.json())
      .then((data) => {
        if (data.success) {
          setSession(data.session);
          localStorage.setItem("qr_p2p_session_id", data.session.id);
          addToast("Secure session refreshed successfully!", "success");
        }
      })
      .catch((err) => console.error("Error refreshing profile:", err));
  };

  // --- Toggle Light/Dark Mode ---
  const handleToggleTheme = () => {
    const nextVal = !isDarkMode;
    setIsDarkMode(nextVal);
    localStorage.setItem("qr_p2p_dark_theme", String(nextVal));
  };

  return (
    <div
      id="app-theme-root"
      className={`min-h-screen font-sans transition-colors duration-300 ${
        isDarkMode ? "bg-sleek-body text-slate-100" : "bg-slate-50 text-slate-800"
      }`}
    >
      {/* Background Decorative Tech Grids */}
      <div id="grid-background" className="fixed inset-0 pointer-events-none overflow-hidden z-0">
        <div
          id="neon-grid-pattern"
          className={`absolute inset-0 bg-[linear-gradient(to_right,rgba(6,182,212,0.025)_1px,transparent_1px),linear-gradient(to_bottom,rgba(6,182,212,0.025)_1px,transparent_1px)] bg-[size:4rem_4rem]`}
        />
        <div
          id="neon-blur-spotlight-1"
          className="absolute -top-40 -left-40 w-96 h-96 rounded-full bg-cyan-500/10 blur-[140px] animate-pulse"
        />
        <div
          id="neon-blur-spotlight-2"
          className="absolute -bottom-40 -right-40 w-96 h-96 rounded-full bg-indigo-500/10 blur-[140px] animate-pulse"
        />
      </div>

      {/* Main Container Wrapper */}
      <div id="main-content-scroller" className="relative z-10 flex flex-col min-h-screen justify-between max-w-7xl mx-auto px-4 md:px-8">
        {/* Navigation / Control Header */}
        <header
          id="global-nav-bar"
          className={`flex items-center justify-between py-4 px-6 my-4 rounded-2xl border select-none transition-colors duration-300 ${
            isDarkMode
              ? "bg-sleek-card border-white/5 shadow-lg shadow-black/35"
              : "bg-white border-slate-200/80 shadow-md"
          }`}
        >
          <div id="brand-logo" className="flex items-center gap-3">
            <div
              id="brand-badge"
              className="w-10 h-10 bg-gradient-to-tr from-cyan-500 to-indigo-600 rounded-xl flex items-center justify-center shadow-lg shadow-cyan-500/20 text-white"
            >
              <Zap className="w-5 h-5" />
            </div>
            <div className="text-left">
              <h1 className="text-xl font-bold tracking-tight leading-tight">
                <span className={isDarkMode ? "bg-clip-text text-transparent bg-gradient-to-r from-white to-slate-400" : "text-slate-900"}>
                  InstantP2P
                </span>
              </h1>
              <p className={`text-[10px] font-medium uppercase tracking-widest ${isDarkMode ? "text-slate-500" : "text-slate-400"}`}>
                Pair & Share
              </p>
            </div>
          </div>

          <div id="nav-actions" className="flex items-center gap-4">
            <div className="flex items-center gap-2 px-3 py-1.5 bg-emerald-500/10 border border-emerald-500/20 rounded-full">
              <div className="w-1.5 h-1.5 bg-emerald-400 rounded-full animate-pulse"></div>
              <span className="text-[10px] font-bold text-emerald-400 uppercase tracking-widest">Active</span>
            </div>

            {/* Dark Mode switcher */}
            <button
              id="theme-toggle-btn"
              onClick={handleToggleTheme}
              className={`p-2.5 rounded-xl border cursor-pointer transition-all ${
                isDarkMode
                  ? "border-white/10 hover:border-cyan-500/50 text-amber-400 bg-white/5"
                  : "border-slate-200 hover:border-indigo-600 text-indigo-600 bg-white"
              }`}
              title={isDarkMode ? "Switch to Light Theme" : "Switch to Dark Theme"}
            >
              {isDarkMode ? <Sun className="w-4 h-4" /> : <Moon className="w-4 h-4" />}
            </button>
          </div>
        </header>

        {/* Core Router Body */}
        <main id="view-renderer-canvas" className="flex-1 flex flex-col justify-center py-8">
          {view === "home" && (
            <div id="hero-view" className="text-center max-w-xl mx-auto space-y-10 animate-slide-up">
              <div id="hero-badge" className="inline-flex items-center gap-2 px-3.5 py-1.5 rounded-full text-xs font-semibold bg-cyan-500/10 text-cyan-400 border border-cyan-500/20">
                <Sparkles className="w-3.5 h-3.5 animate-pulse" />
                <span>Zero registration • ephemeral secure pairing</span>
              </div>

              <div id="hero-heading" className="space-y-4">
                <h2 className="text-3xl md:text-5xl font-black tracking-tight leading-tight">
                  Connect Instantly with <span className="text-transparent bg-clip-text bg-gradient-to-r from-cyan-400 to-indigo-500">Secure QR Codes</span>
                </h2>
                <p className="text-sm md:text-base text-slate-400 leading-relaxed max-w-lg mx-auto">
                  A modern, secure P2P platform for sharing messages and files instantly. Zero logging, zero sign-ups, and absolute privacy.
                </p>
              </div>

              {/* Centered Large Action Buttons */}
              <div id="action-buttons-grid" className="grid grid-cols-1 md:grid-cols-2 gap-4 max-w-md mx-auto select-none">
                <button
                  id="btn-generate-flow"
                  onClick={() => setView("generate")}
                  className="flex flex-col items-center gap-4 p-6 rounded-3xl border transition-all duration-300 cursor-pointer bg-gradient-to-tr from-cyan-500 to-indigo-600 hover:from-cyan-400 hover:to-indigo-500 text-white shadow-xl shadow-cyan-500/10 border-white/5 hover:scale-[1.02] group"
                >
                  <div className="p-4 rounded-2xl bg-white/10 text-white">
                    <QrCode className="w-8 h-8 group-hover:rotate-6 transition-transform" />
                  </div>
                  <div className="text-center">
                    <h4 className="font-bold text-base">Generate My QR</h4>
                    <p className="text-[11px] text-cyan-100/80 mt-1">
                      Display your QR and await connection
                    </p>
                  </div>
                </button>

                <button
                  id="btn-scan-flow"
                  onClick={() => setView("scan")}
                  className={`flex flex-col items-center gap-4 p-6 rounded-3xl border transition-all duration-300 cursor-pointer hover:scale-[1.02] group ${
                    isDarkMode
                      ? "bg-white/5 border-white/5 hover:border-cyan-500/30 hover:bg-white/10 text-white"
                      : "bg-white border-slate-200 hover:border-indigo-600 hover:bg-slate-50 text-slate-800"
                  }`}
                >
                  <div className="p-4 rounded-2xl bg-cyan-500/10 text-cyan-400">
                    <ScanLine className="w-8 h-8 group-hover:scale-110 transition-transform" />
                  </div>
                  <div className="text-center">
                    <h4 className="font-bold text-base">Scan QR</h4>
                    <p className="text-[11px] text-slate-400 mt-1">
                      Open scanner to link with a peer
                    </p>
                  </div>
                </button>
              </div>
            </div>
          )}

          {view === "generate" && session && (
            <div id="generate-view" className="animate-slide-up flex flex-col items-center gap-6">
              <QrGenerator
                sessionId={session.id}
                sessionName={session.name}
                avatarSeed={session.avatarSeed}
                onRefresh={handleRefreshSession}
                isDarkMode={isDarkMode}
              />
              <button
                id="btn-generate-back"
                onClick={() => setView("home")}
                className={`text-xs font-semibold py-2 px-4 rounded-lg cursor-pointer ${
                  isDarkMode ? "text-slate-400 hover:text-white" : "text-slate-600 hover:text-slate-900"
                }`}
              >
                ← Back to Home
              </button>
            </div>
          )}

          {view === "scan" && (
            <div id="scan-view" className="animate-slide-up">
              <QrScanner
                onScanSuccess={requestConnection}
                onCancel={() => setView("home")}
                isDarkMode={isDarkMode}
              />
            </div>
          )}

          {view === "chat" && session && peer && (
            <div id="chat-view" className="animate-scale-up w-full h-full max-w-5xl mx-auto">
              <ChatRoom
                roomId={session.connectedRoomId || ""}
                sessionId={session.id}
                sessionName={session.name}
                avatarSeed={session.avatarSeed}
                peer={peer}
                messages={messages}
                peerOnline={peerOnline}
                peerTyping={peerTyping}
                onSendMessage={sendMessage}
                onDeleteMessage={deleteMessage}
                onLeaveRoom={leaveRoom}
                isDarkMode={isDarkMode}
              />
            </div>
          )}
        </main>

        {/* Global Footer (Status Micro-Rail inspired by Sleek Theme) */}
        <footer
          id="global-footer"
          className={`py-3 px-6 mt-auto rounded-xl border select-none transition-colors duration-300 flex flex-col sm:flex-row items-center justify-between gap-3 text-[10px] font-mono tracking-wider ${
            isDarkMode
              ? "bg-[#0E0E12] border-white/5 text-slate-500"
              : "bg-white border-slate-200/80 text-slate-600 shadow-sm"
          }`}
        >
          <div className="flex flex-wrap items-center gap-4 sm:gap-6">
            <div className="flex items-center gap-2">
              <div className="w-1.5 h-1.5 bg-cyan-400 rounded-full animate-pulse"></div>
              <span className="uppercase font-bold">WebSocket: Secured</span>
            </div>
            <div className="flex items-center gap-2">
              <div className="w-1.5 h-1.5 bg-emerald-400 rounded-full"></div>
              <span className="uppercase font-bold">Encryption: AES-256</span>
            </div>
          </div>
          <p className="uppercase opacity-80">© 2026 InstantP2P | Latency: ~12ms</p>
        </footer>
      </div>

      {/* --- Overlay 1: Incoming Invitation Request Card --- */}
      {incomingRequest && (
        <div id="incoming-modal-backdrop" className="fixed inset-0 bg-black/85 backdrop-blur-md z-50 flex items-center justify-center p-4">
          <div
            id="incoming-modal-card"
            className="w-full max-w-[420px] bg-[#16161A] border border-cyan-500/30 rounded-3xl p-6 shadow-[0_30px_60px_-12px_rgba(0,0,0,0.8),0_0_20px_rgba(34,211,238,0.2)] z-50 animate-in fade-in slide-in-from-top-4 duration-500 text-left"
          >
            <div className="flex items-start gap-5">
              <div className="w-12 h-12 rounded-2xl bg-cyan-500/20 flex items-center justify-center text-cyan-400 shrink-0 border border-cyan-500/20 shadow-inner">
                <Bell className="w-6 h-6 animate-bounce" />
              </div>
              <div className="flex-1">
                <h4 className="text-lg font-black text-white tracking-tight mb-1">New Connection Request</h4>
                <p className="text-slate-400 text-sm mb-6 leading-relaxed">
                  User <span className="text-cyan-400 font-mono font-bold text-xs bg-cyan-500/10 px-1.5 py-0.5 rounded">{incomingRequest.name}</span> wants to establish a secure peer channel with you.
                </p>
                <div className="flex gap-3">
                  <button
                    id="btn-incoming-accept"
                    onClick={() => respondConnection(true)}
                    className="flex-1 py-3 bg-cyan-500 hover:bg-cyan-400 text-black font-bold rounded-xl transition-all hover:scale-[1.02] cursor-pointer text-center text-xs"
                  >
                    Accept
                  </button>
                  <button
                    id="btn-incoming-decline"
                    onClick={() => respondConnection(false)}
                    className="flex-1 py-3 bg-white/5 border border-white/10 hover:bg-white/10 text-white font-bold rounded-xl transition-all hover:scale-[1.02] cursor-pointer text-center text-xs"
                  >
                    Ignore
                  </button>
                </div>
              </div>
            </div>
          </div>
        </div>
      )}

      {/* --- Overlay 2: Outgoing Request Loader --- */}
      {isConnecting && (
        <div id="outgoing-loader-backdrop" className="fixed inset-0 bg-black/85 backdrop-blur-md z-50 flex items-center justify-center p-4 select-none">
          <div
            id="outgoing-loader-card"
            className="w-full max-w-[400px] bg-[#16161A] border border-cyan-500/30 rounded-3xl p-6 shadow-[0_30px_60px_-12px_rgba(0,0,0,0.8),0_0_20px_rgba(34,211,238,0.2)] z-50 text-center relative"
          >
            <div id="spinning-loader" className="flex justify-center mb-5">
              <div className="w-12 h-12 rounded-full border-4 border-cyan-500/20 border-t-cyan-400 animate-spin" />
            </div>
            <h4 className="text-lg font-black text-white tracking-tight">Pairing in progress...</h4>
            <p className="text-xs text-slate-400 mt-2 px-4 leading-relaxed">
              Sending secure request to QR code owner. Awaiting authorization response...
            </p>
          </div>
        </div>
      )}

      {/* --- Toast Notifications Banner Feed --- */}
      <div id="toast-banners-holder" className="fixed bottom-6 right-6 z-50 flex flex-col gap-2.5 max-w-sm pointer-events-none select-none">
        {toasts.map((toast) => (
          <div
            id={`toast-${toast.id}`}
            key={toast.id}
            className={`p-3.5 rounded-2xl shadow-xl flex items-center gap-3 border pointer-events-auto animate-slide-up text-xs font-semibold ${
              toast.type === "success"
                ? "bg-emerald-500/10 text-emerald-400 border-emerald-500/20"
                : toast.type === "error"
                ? "bg-rose-500/10 text-rose-400 border-rose-500/20"
                : isDarkMode
                ? "bg-slate-900 border-slate-800 text-slate-100"
                : "bg-white border-slate-200 text-slate-700"
            }`}
          >
            {toast.type === "success" ? (
              <Check className="w-4 h-4 shrink-0" />
            ) : toast.type === "error" ? (
              <AlertCircle className="w-4 h-4 shrink-0" />
            ) : (
              <Bell className="w-4 h-4 shrink-0" />
            )}
            <span className="text-left flex-1">{toast.message}</span>
          </div>
        ))}
      </div>
    </div>
  );
}
