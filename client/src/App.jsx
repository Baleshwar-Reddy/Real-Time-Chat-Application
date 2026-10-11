import { useEffect, useRef, useState } from "react";
import { io } from "socket.io-client";
import "./App.css";

const socket = io({ transports: ["websocket"] });
const SELF_CHAT_ID = "saved";
const GENERAL_CHAT_ID = "general";
const MAX_MESSAGES = 500;

function formatTime(value) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "";
  return date.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
}

function initials(name = "?") {
  return name.trim().split(/\s+/).slice(0, 2).map((part) => part[0]).join("").toUpperCase();
}

function loadSavedMessages() {
  try {
    const saved = JSON.parse(localStorage.getItem("chat-saved-messages") || "[]");
    return Array.isArray(saved) ? saved.slice(-MAX_MESSAGES) : [];
  } catch {
    return [];
  }
}

function persistSavedMessage(message) {
  try {
    const saved = [...loadSavedMessages(), message].slice(-MAX_MESSAGES);
    localStorage.setItem("chat-saved-messages", JSON.stringify(saved));
    return true;
  } catch {
    return false;
  }
}

function App() {
  const [username, setUsername] = useState(() => sessionStorage.getItem("chat-name") || "");
  const [editingName, setEditingName] = useState(!sessionStorage.getItem("chat-name"));
  const [nameDraft, setNameDraft] = useState("");
  const [message, setMessage] = useState("");
  const [messages, setMessages] = useState(loadSavedMessages);
  const [users, setUsers] = useState([]);
  const [activeCount, setActiveCount] = useState(0);
  const [ownId, setOwnId] = useState(socket.id);
  const [chatError, setChatError] = useState("");
  const [selectedChat, setSelectedChat] = useState({ id: GENERAL_CHAT_ID, name: "General Channel", type: "channel" });
  const messagesEndRef = useRef(null);

  useEffect(() => {
    const onMessage = (data) => setMessages((previous) => [...previous.slice(-(MAX_MESSAGES - 1)), data]);
    const onUsers = ({ users: list = [], count = list.length } = {}) => {
      setUsers(list);
      setActiveCount(count);
    };
    const onUserJoined = ({ user, count }) => {
      setActiveCount(count);
      setUsers((previous) => previous.some((item) => item.id === user.id) || previous.length >= 100
        ? previous
        : [...previous, user]);
    };
    const onUserRenamed = ({ user, count }) => {
      setActiveCount(count);
      setUsers((previous) => previous.map((item) => item.id === user.id ? user : item));
      setSelectedChat((current) => current.type === "direct" && current.id === user.id
        ? { ...current, name: user.name }
        : current);
    };
    const onUserLeft = ({ id, count }) => {
      if (typeof count === "number") setActiveCount(count);
      setUsers((previous) => previous.filter((item) => item.id !== id));
    };
    const onOnlineCount = (count) => setActiveCount(count);
    const onConnect = () => {
      setOwnId(socket.id);
      if (username) socket.emit("set_username", username);
    };

    socket.on("receive_message", onMessage);
    socket.on("online_users", onUsers);
    socket.on("user_joined", onUserJoined);
    socket.on("user_renamed", onUserRenamed);
    socket.on("user_left", onUserLeft);
    socket.on("online_count", onOnlineCount);
    socket.on("connect", onConnect);
    if (socket.connected && username) socket.emit("set_username", username);

    return () => {
      socket.off("receive_message", onMessage);
      socket.off("online_users", onUsers);
      socket.off("user_joined", onUserJoined);
      socket.off("user_renamed", onUserRenamed);
      socket.off("user_left", onUserLeft);
      socket.off("online_count", onOnlineCount);
      socket.off("connect", onConnect);
    };
  }, [username]);

  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: "smooth", block: "end" });
  }, [messages]);

  const saveName = (event) => {
    event?.preventDefault();
    const cleanName = nameDraft.trim();
    if (!cleanName) return;
    sessionStorage.setItem("chat-name", cleanName);
    setUsername(cleanName);
    setEditingName(false);
  };

  const sendMessage = () => {
    const cleanMessage = message.trim();
    if (!username.trim() || !cleanMessage) return;
    setChatError("");

    if (selectedChat.type === "saved") {
      const savedMessage = {
        username,
        message: cleanMessage,
        timestamp: new Date().toISOString(),
        senderId: ownId,
        conversationId: SELF_CHAT_ID,
      };
      if (!persistSavedMessage(savedMessage)) setChatError("Saved messages could not be stored on this device.");
      setMessages((previous) => [...previous.slice(-(MAX_MESSAGES - 1)), savedMessage]);
    } else {
      socket.emit("send_message", {
        message: cleanMessage,
        recipientId: selectedChat.type === "direct" ? selectedChat.id : undefined,
      }, (result) => {
        if (result?.error) {
          setChatError(result.error);
          setMessage((current) => current || cleanMessage);
        }
      });
    }
    setMessage("");
  };

  const openChat = (chat) => {
    setSelectedChat(chat);
    setChatError("");
  };

  const conversationId = selectedChat.type === "direct"
    ? `dm:${[ownId, selectedChat.id].sort().join(":")}`
    : selectedChat.id;
  const selectedContactOnline = users.some((user) => user.id === selectedChat.id);
  const visibleMessages = messages.filter((item) => (item.conversationId || GENERAL_CHAT_ID) === conversationId);
  const chatPreview = (id) => {
    const latest = [...messages].reverse().find((item) => item.conversationId === id);
    return latest?.message || latest?.text || "Start a conversation";
  };

  return (
    <main className="chat-shell">
      <aside className="sidebar">
        <header className="sidebar-heading">
          <div>
            <h1>Real-Time Chat</h1>
            <p>{activeCount} active</p>
          </div>
          {username && <button className="profile-button" type="button" aria-label="Edit name" onClick={() => { setNameDraft(username); setEditingName(true); }}>Edit name</button>}
        </header>

        <div className="chat-list" aria-label="Chats">
          <button className={`chat-row ${selectedChat.id === GENERAL_CHAT_ID ? "chat-row-active" : ""}`} type="button" onClick={() => openChat({ id: GENERAL_CHAT_ID, name: "General Channel", type: "channel" })}>
            <span className="avatar channel-avatar">#</span>
            <span className="chat-row-copy"><span className="chat-row-name">General Channel</span><span className="chat-row-preview">{chatPreview(GENERAL_CHAT_ID)}</span></span>
          </button>
          <button className={`chat-row ${selectedChat.id === SELF_CHAT_ID ? "chat-row-active" : ""}`} type="button" onClick={() => openChat({ id: SELF_CHAT_ID, name: "Saved messages", type: "saved" })}>
            <span className="avatar saved-avatar">✓</span>
            <span className="chat-row-copy"><span className="chat-row-name">Saved messages</span><span className="chat-row-preview">{chatPreview(SELF_CHAT_ID)}</span></span>
          </button>

          <p className="contacts-heading">ONLINE CONTACTS</p>
          {users.filter((user) => user.id !== ownId).map((user) => {
            const active = selectedChat.type === "direct" && selectedChat.id === user.id;
            const id = `dm:${[ownId, user.id].sort().join(":")}`;
            return (
              <button className={`chat-row ${active ? "chat-row-active" : ""}`} key={user.id} type="button" onClick={() => openChat({ id: user.id, name: user.name, type: "direct" })}>
                <span className="avatar">{initials(user.name)}</span>
                <span className="chat-row-copy"><span className="chat-row-name">{user.name}</span><span className="chat-row-preview">{chatPreview(id)}</span></span>
                <span className="contact-dot" aria-label="Online" />
              </button>
            );
          })}
          {!users.filter((user) => user.id !== ownId).length && <p className="empty-users">No other users online yet.</p>}
          {activeCount > users.length && <p className="user-limit-note">Showing {users.length} of {activeCount} online</p>}
        </div>
      </aside>

      <section className="conversation">
        <header className="channel-header">
          <span className={`status-dot ${selectedChat.type === "saved" ? "saved-status" : ""}`} />
          <div className="conversation-title"><h2>{selectedChat.name}</h2><span>{selectedChat.type === "channel" ? `${activeCount} people online` : selectedChat.type === "saved" ? "Only you can see these messages" : selectedContactOnline ? "Online now" : "Offline"}</span></div>
        </header>
        <div className="messages" aria-live="polite">
          {visibleMessages.length === 0 && selectedChat.type === "saved" && <p className="conversation-empty">Write a note to yourself. Your saved messages stay on this device.</p>}
          {visibleMessages.length === 0 && selectedChat.type === "direct" && <p className="conversation-empty">This is the beginning of your private conversation with {selectedChat.name}.</p>}
          {visibleMessages.map((msg, index) => msg.type === "notice" ? (
            <p className="system-notice" key={`${msg.timestamp}-${index}`}>{msg.text}<time>{formatTime(msg.timestamp)}</time></p>
          ) : (
            <article className={`message ${msg.senderId === ownId || selectedChat.type === "saved" ? "message-own" : ""}`} key={`${msg.timestamp}-${index}`}>
              <span className="message-author">{msg.senderId === ownId || selectedChat.type === "saved" ? "You" : msg.username}</span><p>{msg.message}</p>
              <time className="message-time">{formatTime(msg.timestamp)}</time>
            </article>
          ))}
          <div ref={messagesEndRef} />
        </div>
        {chatError && <p className="chat-error" role="status">{chatError}</p>}
        <form className="composer" onSubmit={(event) => { event.preventDefault(); sendMessage(); }}>
          <input aria-label="Type a message" placeholder={username ? "Type a message..." : "Choose a name to start chatting..."} value={message} onChange={(event) => setMessage(event.target.value)} disabled={!username} maxLength={2000} />
          <button type="submit" disabled={!username || !message.trim()}>Send</button>
        </form>
      </section>

      {editingName && (
        <div className="name-dialog-backdrop">
          <form className="name-dialog" onSubmit={saveName}>
            <h2>{username ? "Change your name" : "Choose a display name"}</h2>
            <label htmlFor="display-name">Your name is visible to other people in the chat.</label>
            <input id="display-name" autoFocus required maxLength={32} placeholder="Your name" value={nameDraft} onChange={(event) => setNameDraft(event.target.value)} />
            <button type="submit">{username ? "Save name" : "Join chat"}</button>
          </form>
        </div>
      )}
    </main>
  );
}

export default App;
