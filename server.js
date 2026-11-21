const express = require("express");
const http = require("http");
const { Server } = require("socket.io");
const crypto = require("crypto");

const app = express();
const server = http.createServer(app);
const io = new Server(server);
const PORT = process.env.PORT || 3000;

app.use(express.static("public"));

const QUESTIONS = [
  {
    title: "Entrada de capital",
    question: "Quando os sócios realizam entradas de capital em dinheiro, qual é o principal efeito?",
    options: ["Aumenta o capital próprio e entra dinheiro na empresa", "Aumenta sempre o passivo", "É registado como um gasto"],
    correct: 0,
    explanation: "A entrada dos sócios aumenta os recursos próprios da empresa."
  },
  {
    title: "Suprimentos",
    question: "Em regra, os suprimentos realizados por um sócio representam:",
    options: ["Um rendimento", "Um financiamento da empresa pelo sócio", "Uma reserva legal"],
    correct: 1,
    explanation: "Os suprimentos são, em regra, empréstimos dos sócios à sociedade."
  },
  {
    title: "Prestações acessórias",
    question: "As prestações acessórias são:",
    options: ["Obrigações adicionais dos sócios previstas no contrato", "Vendas realizadas pela empresa", "Impostos sobre o lucro"],
    correct: 0,
    explanation: "São prestações adicionais dos sócios, nos termos definidos no contrato de sociedade."
  },
  {
    title: "Reservas",
    question: "Qual é a finalidade principal da reserva legal?",
    options: ["Distribuir todo o lucro", "Reforçar a proteção do capital próprio", "Pagar salários"],
    correct: 1,
    explanation: "A reserva legal constitui uma parcela dos resultados retida na empresa."
  },
  {
    title: "Quotas ou ações próprias",
    question: "Quando uma sociedade adquire quotas ou ações próprias, estas:",
    options: ["Aumentam automaticamente o capital social", "São apresentadas como dedução ao capital próprio", "São um ativo fixo tangível"],
    correct: 1,
    explanation: "As participações próprias são apresentadas como dedução ao capital próprio."
  },
  {
    title: "Perda de capital",
    question: "Uma situação de perda de capital pode indicar que:",
    options: ["O capital próprio diminuiu significativamente", "A empresa aumentou sempre as vendas", "Não existem dívidas"],
    correct: 0,
    explanation: "As perdas acumuladas podem reduzir de forma significativa o capital próprio."
  },
  {
    title: "Dividendos antecipados",
    question: "A distribuição antecipada de dividendos exige especial atenção porque:",
    options: ["Pode comprometer a situação financeira e patrimonial", "Aumenta sempre o resultado líquido", "Elimina o passivo"],
    correct: 0,
    explanation: "A distribuição deve respeitar os requisitos legais e a existência de resultados distribuíveis."
  }
];

const rooms = new Map();
const makeCode = () => crypto.randomBytes(3).toString("hex").toUpperCase();

function publicState(room) {
  return {
    code: room.code,
    hostConnected: room.hostConnected,
    started: room.started,
    questionIndex: room.questionIndex,
    question: room.started && room.questionIndex >= 0 ? {
      title: QUESTIONS[room.questionIndex].title,
      question: QUESTIONS[room.questionIndex].question,
      options: QUESTIONS[room.questionIndex].options
    } : null,
    players: [...room.players.values()].map(p => ({
      id: p.id, name: p.name, score: p.score, answered: p.answered
    })).sort((a,b) => b.score - a.score),
    totalQuestions: QUESTIONS.length,
    finished: room.finished
  };
}
function broadcast(room) { io.to(room.code).emit("room-state", publicState(room)); }
function ranking(room) {
  return [...room.players.values()].sort((a,b) => b.score-a.score);
}
function nextQuestion(room) {
  room.questionIndex += 1;
  room.finished = room.questionIndex >= QUESTIONS.length;
  if (room.finished) {
    room.started = false;
    broadcast(room);
    io.to(room.code).emit("game-finished", ranking(room).map((p,i)=>({name:p.name,score:p.score,place:i+1})));
    return;
  }
  room.players.forEach(p => { p.answered = false; p.lastAnswer = null; });
  room.deadline = Date.now() + 15000;
  broadcast(room);
  io.to(room.code).emit("question-start", { index: room.questionIndex, duration: 15 });
  clearTimeout(room.timer);
  room.timer = setTimeout(() => {
    room.players.forEach(p => {
      if (!p.answered) p.answered = true;
    });
    io.to(room.code).emit("question-ended", { reason: "timeout" });
    broadcast(room);
    room.timer = setTimeout(() => nextQuestion(room), 3500);
  }, 15000);
}

io.on("connection", socket => {
  socket.on("host:create", () => {
    let code = makeCode();
    while (rooms.has(code)) code = makeCode();
    const room = { code, hostId: socket.id, hostConnected: true, players: new Map(),
      started: false, finished: false, questionIndex: -1, deadline: 0, timer: null };
    rooms.set(code, room);
    socket.join(code);
    socket.emit("room-created", { code });
    broadcast(room);
  });

  socket.on("player:join", ({code, name} = {}) => {
    code = String(code || "").trim().toUpperCase();
    name = String(name || "").trim().slice(0, 18);
    const room = rooms.get(code);
    if (!room) return socket.emit("join-error", "Não encontrámos essa sala. Confirma o código.");
    if (!name) return socket.emit("join-error", "Escreve o teu nome.");
    if (room.started) return socket.emit("join-error", "O jogo já começou.");
    const player = { id: socket.id, name, score: 0, answered: false, lastAnswer: null };
    room.players.set(socket.id, player);
    socket.join(code);
    socket.data.roomCode = code;
    socket.emit("joined-room", { code, playerId: socket.id });
    broadcast(room);
  });

  socket.on("host:start", ({code} = {}) => {
    const room = rooms.get(String(code || "").toUpperCase());
    if (!room || room.hostId !== socket.id) return;
    if (room.players.size < 1) return socket.emit("host-error", "É preciso pelo menos um jogador para começar.");
    if (room.started) return;
    room.started = true;
    room.questionIndex = -1;
    nextQuestion(room);
  });

  socket.on("player:answer", ({choice} = {}) => {
    const code = socket.data.roomCode;
    const room = rooms.get(code);
    if (!room || !room.started || room.finished) return;
    const player = room.players.get(socket.id);
    if (!player || player.answered) return;
    const q = QUESTIONS[room.questionIndex];
    const correct = Number(choice) === q.correct;
    const remaining = Math.max(0, room.deadline - Date.now());
    const points = correct ? 1000 + Math.round(remaining / 15) : 0;
    player.score += points;
    player.answered = true;
    player.lastAnswer = Number(choice);
    const sorted = ranking(room);
    const place = sorted.findIndex(p => p.id === socket.id) + 1;
    socket.emit("answer-result", {
      correct, points, explanation: q.explanation, place,
      top: sorted.slice(0,4).map((p,i)=>({name:p.name,score:p.score,place:i+1})),
      totalPlayers: sorted.length
    });
    broadcast(room);
    if ([...room.players.values()].every(p => p.answered)) {
      clearTimeout(room.timer);
      io.to(room.code).emit("question-ended", { reason: "all-answered" });
      room.timer = setTimeout(() => nextQuestion(room), 3500);
    }
  });

  socket.on("host:next", ({code} = {}) => {
    const room = rooms.get(String(code || "").toUpperCase());
    if (!room || room.hostId !== socket.id || !room.started) return;
    clearTimeout(room.timer);
    nextQuestion(room);
  });

  socket.on("disconnect", () => {
    const code = socket.data.roomCode;
    if (code && rooms.has(code)) {
      const room = rooms.get(code);
      room.players.delete(socket.id);
      broadcast(room);
    }
    for (const room of rooms.values()) {
      if (room.hostId === socket.id) {
        room.hostConnected = false;
        broadcast(room);
      }
    }
  });
});

server.listen(PORT, () => console.log(`Capital City a correr na porta ${PORT}`));
