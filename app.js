import { Chess } from "https://esm.sh/chess.js@0.12.0";
import { Chessground } from "https://esm.sh/chessground@8.3.4";

const scenarios = {
  free: {
    name: "Partida Livre",
    fen: "start",
    objective: "Derrote o oponente.",
    forcedColor: null,
    winCondition: (g) => g.in_checkmate() && g.turn() !== userColor,
    failCondition: (g) =>
      g.game_over() && !(g.in_checkmate() && g.turn() !== userColor),
  },
  survival_1: {
    name: "Sobrevivência: Ataque Feroz",
    fen: "r1b2rk1/pp1p1ppp/2p5/4P3/2B1n2q/2N5/PPP2PPP/R1BQK2R w KQ - 3 10",
    objective: "Sobreviva por 20 lances seguidos sem levar Mate.",
    forcedColor: "w",
    targetMoves: 20,
    winCondition: (g, count) => count >= 20,
    failCondition: (g) => g.in_checkmate() && g.turn() === "w",
  },
  endgame_1: {
    name: "Final: O Rei e o Peão",
    fen: "8/8/8/8/4k3/8/4P3/4K3 w - - 0 1",
    objective: "Dê Xeque-Mate promovendo o peão. (Empate = Falha)",
    forcedColor: "w",
    winCondition: (g) => g.in_checkmate() && g.turn() === "b",
    failCondition: (g) =>
      g.in_draw() ||
      g.in_stalemate() ||
      g.in_threefold_repetition() ||
      g.insufficient_material(),
  },
};

const game = new Chess();
const boardElement = document.getElementById("board");
const feedbackEl = document.getElementById("feedback");
const evalScoreEl = document.getElementById("eval-score");
const undoBtn = document.getElementById("undo-btn");
const objectivePanel = document.getElementById("objective-panel");
const objectiveText = document.getElementById("objective-text");
const objectiveProgress = document.getElementById("objective-progress");
const worker = new Worker("worker.js");

worker.postMessage("uci");
worker.postMessage("isready");

let currentMode = "free",
  userColor = "w",
  botDepth = 5,
  currentTask = "idle";
let lastEvalScore = 0.0,
  tempScore = 0.0,
  userBestMoves = [];
let gameSnapshots = [],
  viewPly = 0,
  maxPly = 0,
  movesSurvived = 0;

const cg = Chessground(boardElement, {
  fen: game.fen(),
  turnColor: "white",
  movable: { free: false, dests: new Map() },
  events: { move: handleUserMove },
  drawable: { enabled: true, visible: true, autoShapes: [] },
});

worker.onmessage = function (e) {
  const line = e.data;
  if (typeof line !== "string") return;

  if (line.startsWith("info depth") && line.includes("score")) {
    const parsed = parseStockfishInfo(line, game.fen());
    if (currentTask === "analyzing_user_options") {
      if (parsed.multiPvIndex <= 3 && parsed.pvLine.length > 0) {
        userBestMoves[parsed.multiPvIndex - 1] = {
          move: parsed.pvLine[0],
          score: parsed.score,
          san: getSan(game.fen(), parsed.pvLine[0]),
        };
        if (parsed.multiPvIndex === 1) {
          lastEvalScore = parsed.score;
          updateEvalUI(lastEvalScore);
        }
      }
    } else {
      tempScore = parsed.score;
      updateEvalUI(tempScore);
    }
  }

  if (line.startsWith("bestmove")) {
    const bestMove = line.match(/bestmove\s+(\S+)/)?.[1];
    if (currentTask === "evaluating_user_move") processUserEvaluation();
    else if (currentTask === "bot_thinking") executeBotMove(bestMove);
  }
};

function checkScenarioStatus() {
  const scenario = scenarios[currentMode];
  if (scenario.failCondition(game)) {
    feedbackEl.className = "feedback-box bad";
    feedbackEl.innerHTML = `<strong>Missão Falhou!</strong> Fim de jogo.<br><br><button onclick="document.getElementById('start-btn').click()">Tentar Novamente</button>`;
    cg.set({ movable: { dests: new Map() } });
    return true;
  }
  if (scenario.winCondition(game, movesSurvived)) {
    feedbackEl.className = "feedback-box good";
    feedbackEl.innerHTML = `<strong>🏆 Missão Cumprida!</strong> Excelente execução.<br><br><button onclick="document.getElementById('start-btn').click()">Jogar Novamente</button>`;
    cg.set({ movable: { dests: new Map() } });
    return true;
  }
  return false;
}

function handleUserMove(orig, dest) {
  worker.postMessage("stop");
  undoBtn.disabled = true;
  const move = game.move({ from: orig, to: dest, promotion: "q" });
  if (!move) return;

  movesSurvived++;
  if (currentMode === "survival_1")
    objectiveProgress.innerText = `Progresso: ${movesSurvived} / ${scenarios[currentMode].targetMoves} lances`;

  cg.set({ movable: { dests: new Map() }, drawable: { autoShapes: [] } });
  feedbackEl.className = "feedback-box info";
  feedbackEl.innerText = "Julgando a sua jogada...";
  if (checkScenarioStatus()) return;

  currentTask = "evaluating_user_move";
  worker.postMessage("setoption name MultiPV value 1");
  worker.postMessage("position fen " + game.fen());
  worker.postMessage("go depth 12");
}

// -----------------------------------------
// NOVO: AVALIADOR DE QUALIDADE
// -----------------------------------------
function getMoveQuality(evalChange) {
  if (evalChange >= 0.0)
    return { label: "⭐ Excelente", class: "good", color: "#a6e3a1" };
  if (evalChange >= -0.8)
    return { label: "✔️ Boa", class: "good", color: "#89b4fa" };
  if (evalChange >= -1.5)
    return { label: "⚠️ Imprecisão", class: "info", color: "#f9e2af" };
  if (evalChange >= -3.0)
    return { label: "❌ Erro", class: "bad", color: "#fab387" };
  return { label: "💀 Erro Grave", class: "bad", color: "#f38ba8" };
}

function processUserEvaluation() {
  let evalChange =
    userColor === "w" ? tempScore - lastEvalScore : lastEvalScore - tempScore;
  const quality = getMoveQuality(evalChange);
  const optionsList = userBestMoves.filter((bm) => bm && bm.move).slice(0, 3);
  const punishmentMoveStr = optionsList.length > 0 ? optionsList[0].move : null;

  // Texto Pedagógico
  let feedbackText = "";
  if (evalChange < -0.8) {
    feedbackText = generatePedagogicalFeedback(
      game.fen(),
      punishmentMoveStr,
      evalChange,
    );
  } else {
    feedbackText =
      "A sua jogada cumpriu os requisitos da posição e manteve a estabilidade ou vantagem.";
  }

  // Lista de Top 3 Jogadas do Coach
  let optionsHtml =
    optionsList.length > 0
      ? optionsList
          .map((bm, i) => {
            const colors = ["#a6e3a1", "#89b4fa", "#f9e2af"];
            const names = ["Verde", "Azul", "Amarelo"];
            const scoreTxt =
              bm.score > 0 ? `+${bm.score.toFixed(2)}` : bm.score.toFixed(2);
            return `<li style="color: ${colors[i]}"><strong>Seta ${names[i]}:</strong> ${bm.san} <em>(${scoreTxt})</em></li>`;
          })
          .join("")
      : `<li><em>Calculando alternativas...</em></li>`;

  // Atualiza Interface (Monta o Card)
  feedbackEl.className = `feedback-box ${quality.class}`;
  feedbackEl.innerHTML = `
    <div style="font-size: 1.2em; margin-bottom: 8px;">
      <strong style="color: ${quality.color};">${quality.label}</strong> 
      <span style="font-size: 0.8em; opacity: 0.8;">(${evalChange > 0 ? "+" : ""}${evalChange.toFixed(1)} pts)</span>
    </div>
    <div style="background: rgba(0,0,0,0.2); padding: 10px; border-radius: 6px; margin-bottom: 12px; font-size: 0.95em;">
      ${feedbackText}
    </div>
    Alternativas recomendadas pelo Coach:
    <ul class="coach-options">${optionsHtml}</ul>
  `;

  // Desenha as setas SEMPRE
  const brushes = ["green", "blue", "yellow"];
  const customShapes = optionsList.map((bm, i) => ({
    orig: bm.move.substring(0, 2),
    dest: bm.move.substring(2, 4),
    brush: brushes[i],
  }));
  cg.set({ drawable: { autoShapes: customShapes } });

  lastEvalScore = tempScore;

  // Lógica de Fluxo (Pausar ou Continuar)
  if (evalChange < -0.8) {
    // Imprecisão/Erro: Pausa o jogo e obriga o jogador a analisar
    currentTask = "waiting_for_continue";
    undoBtn.disabled = false;
    feedbackEl.innerHTML += `<br>Clique em <strong>Desfazer Jogada</strong>, ou <a href="#" id="continue-link" style="color: #f38ba8;">continue a partida</a>.`;
    commitSnapshot();
  } else {
    // Boa/Excelente: Grava na Máquina do Tempo e continua sem travar o jogo
    commitSnapshot();
    if (!game.game_over()) triggerBotMove();
  }
}

// -----------------------------------------
// MOTOR PEDAGÓGICO DE DICAS
// -----------------------------------------
const pieceValues = { p: 1, n: 3, b: 3, r: 5, q: 9, k: 1000 };
const pieceNames = {
  p: "Peão",
  n: "Cavalo",
  b: "Bispo",
  r: "Torre",
  q: "Dama",
  k: "Rei",
};

function generatePedagogicalFeedback(fen, punishmentMoveStr, evalChange) {
  if (!punishmentMoveStr) return "Desvio do objetivo estratégico.";
  const dummyBoard = new Chess(fen);
  const punishmentMove = dummyBoard.move({
    from: punishmentMoveStr.substring(0, 2),
    to: punishmentMoveStr.substring(2, 4),
    promotion: punishmentMoveStr.length > 4 ? punishmentMoveStr[4] : "q",
  });
  if (!punishmentMove) return "Desvantagem posicional.";

  if (dummyBoard.in_checkmate())
    return `<strong>Mate Iminente!</strong> O seu Rei não tem rotas de fuga contra a resposta inimiga.`;

  if (currentMode === "endgame_1") {
    if (dummyBoard.in_stalemate())
      return `<strong>Rei Afogado!</strong> A jogada retira as casas legais do oponente sem dar xeque, causando empate direto.`;
    if (punishmentMove.captured === "p")
      return `<strong>Peão Perdido:</strong> Sem o peão, o jogo empata por insuficiência material.`;
  }

  if (punishmentMove.captured) {
    const lostVal = pieceValues[punishmentMove.captured],
      atkVal = pieceValues[punishmentMove.piece];
    if (lostVal > atkVal)
      return `<strong>Troca Desvantajosa:</strong> O oponente vai capturar o seu(sua) ${pieceNames[punishmentMove.captured]} usando um(a) ${pieceNames[punishmentMove.piece]}.`;
    return `<strong>Pendurada Material:</strong> Você entregou o(a) seu(sua) ${pieceNames[punishmentMove.captured]} sem defesa suficiente.`;
  }
  if (dummyBoard.in_check())
    return `<strong>Exposição:</strong> O seu Rei será atacado com ganho de tempo, perdendo a iniciativa.`;
  return `<strong>Erro Posicional:</strong> A jogada cede espaço. O oponente dominará com <strong>${punishmentMove.san}</strong>.`;
}

function startUserTurn() {
  if (checkScenarioStatus()) return;
  currentTask = "analyzing_user_options";
  userBestMoves = [];
  worker.postMessage("setoption name MultiPV value 3");
  worker.postMessage("position fen " + game.fen());
  worker.postMessage("go depth 12");
  cg.set({
    turnColor: userColor === "w" ? "white" : "black",
    movable: { free: false, dests: getLegalDests(game) },
  });
  feedbackEl.className = "feedback-box info";
  feedbackEl.innerHTML = "<strong>Sua vez.</strong> Analisando a posição...";
  commitSnapshot();
}

function triggerBotMove() {
  if (checkScenarioStatus()) return;
  currentTask = "bot_thinking";
  const actualDepth = currentMode === "survival_1" ? 15 : botDepth;
  worker.postMessage("setoption name MultiPV value 1");
  worker.postMessage("position fen " + game.fen());
  worker.postMessage("go depth " + actualDepth);
  feedbackEl.innerHTML +=
    '<hr style="border:0; border-top:1px solid rgba(255,255,255,0.1); margin: 10px 0;"><em style="opacity:0.8;">Oponente a processar jogada...</em>';
}

function executeBotMove(bestMove) {
  if (!bestMove) return;
  game.move({
    from: bestMove.substring(0, 2),
    to: bestMove.substring(2, 4),
    promotion: bestMove.length > 4 ? bestMove[4] : "q",
  });
  cg.set({ fen: game.fen() });
  startUserTurn();
}

// -----------------------------------------
// CONTROLES DE INTERFACE & HISTÓRICO
// -----------------------------------------
document.getElementById("mode-select").addEventListener("change", (e) => {
  const scenario = scenarios[e.target.value],
    colorGroup = document.getElementById("color-group");
  if (scenario.forcedColor) {
    document.getElementById("color-select").value = scenario.forcedColor;
    colorGroup.style.opacity = "0.5";
    colorGroup.style.pointerEvents = "none";
  } else {
    colorGroup.style.opacity = "1";
    colorGroup.style.pointerEvents = "auto";
  }
});

document.getElementById("start-btn").addEventListener("click", () => {
  currentMode = document.getElementById("mode-select").value;
  const scenario = scenarios[currentMode];
  userColor = scenario.forcedColor
    ? scenario.forcedColor
    : document.getElementById("color-select").value;
  botDepth = parseInt(document.getElementById("difficulty-select").value);
  movesSurvived = 0;

  if (scenario.fen === "start") game.reset();
  else game.load(scenario.fen);
  gameSnapshots = [];
  lastEvalScore = 0.0;
  updateEvalUI(0);
  cg.set({
    fen: game.fen(),
    orientation: userColor === "w" ? "white" : "black",
    drawable: { autoShapes: [] },
  });

  objectiveText.innerText = scenario.objective;
  if (scenario.targetMoves) {
    objectiveProgress.style.display = "block";
    objectiveProgress.innerText = `Progresso: 0 / ${scenario.targetMoves}`;
  } else {
    objectiveProgress.style.display = "none";
  }
  objectivePanel.style.display = "block";

  if (game.turn() !== userColor) {
    feedbackEl.className = "feedback-box info";
    feedbackEl.innerText = "Oponente inicia o módulo.";
    commitSnapshot();
    triggerBotMove();
  } else {
    startUserTurn();
  }
});

feedbackEl.addEventListener("click", (e) => {
  if (e.target && e.target.id === "continue-link") {
    e.preventDefault();
    if (viewPly < maxPly) return;
    undoBtn.disabled = true;
    lastEvalScore = tempScore;
    cg.set({ drawable: { autoShapes: [] } });
    triggerBotMove();
  }
});

undoBtn.addEventListener("click", () => {
  worker.postMessage("stop");
  if (game.history().length > 0) game.undo();
  if (game.turn() !== userColor && game.history().length > 0) game.undo();
  if (currentMode === "survival_1")
    movesSurvived = Math.max(0, movesSurvived - 1);
  gameSnapshots.length = game.history().length + 1;
  cg.set({ fen: game.fen(), drawable: { autoShapes: [] } });
  startUserTurn();
});

function commitSnapshot() {
  const currentPly = game.history().length;
  maxPly = currentPly;
  viewPly = maxPly;
  let currentShapes = [];
  if (cg.state.drawable && cg.state.drawable.autoShapes)
    currentShapes = JSON.parse(JSON.stringify(cg.state.drawable.autoShapes));
  gameSnapshots[currentPly] = {
    fen: game.fen(),
    scoreText: evalScoreEl ? evalScoreEl.innerText : "0.0",
    feedbackClass: feedbackEl.className,
    feedbackHtml: feedbackEl.innerHTML,
    shapes: currentShapes,
  };
  updateNavButtons();
}
function loadSnapshot(ply) {
  if (ply < 0 || ply > maxPly) return;
  viewPly = ply;
  const snap = gameSnapshots[ply];
  if (!snap) return;
  cg.set({ fen: snap.fen, drawable: { autoShapes: snap.shapes } });
  feedbackEl.className = snap.feedbackClass;
  feedbackEl.innerHTML = snap.feedbackHtml;
  if (evalScoreEl) evalScoreEl.innerText = snap.scoreText;
  if (viewPly < maxPly) {
    cg.set({ movable: { free: false, dests: new Map() } });
    feedbackEl.style.pointerEvents = "none";
  } else {
    feedbackEl.style.pointerEvents = "auto";
    if (currentTask === "analyzing_user_options")
      cg.set({ movable: { free: false, dests: getLegalDests(game) } });
    else if (currentTask === "waiting_for_continue")
      cg.set({ movable: { free: false, dests: new Map() } });
  }
  updateNavButtons();
}
function updateNavButtons() {
  document.getElementById("nav-first").disabled = viewPly <= 0;
  document.getElementById("nav-prev").disabled = viewPly <= 0;
  document.getElementById("nav-next").disabled = viewPly >= maxPly;
  document.getElementById("nav-last").disabled = viewPly >= maxPly;
  if (viewPly < maxPly) undoBtn.disabled = true;
  else undoBtn.disabled = maxPly === 0 || currentTask === "bot_thinking";
}
document
  .getElementById("nav-first")
  .addEventListener("click", () => loadSnapshot(0));
document
  .getElementById("nav-prev")
  .addEventListener("click", () => loadSnapshot(viewPly - 1));
document
  .getElementById("nav-next")
  .addEventListener("click", () => loadSnapshot(viewPly + 1));
document
  .getElementById("nav-last")
  .addEventListener("click", () => loadSnapshot(maxPly));
document.addEventListener("keydown", (e) => {
  if (e.key === "ArrowLeft" && !document.getElementById("nav-prev").disabled)
    loadSnapshot(viewPly - 1);
  else if (
    e.key === "ArrowRight" &&
    !document.getElementById("nav-next").disabled
  )
    loadSnapshot(viewPly + 1);
});

function updateEvalUI(score) {
  if (evalScoreEl)
    evalScoreEl.innerText =
      score > 0 ? `+${score.toFixed(1)}` : score.toFixed(1);
}
function getLegalDests(chess) {
  const dests = new Map();
  chess.SQUARES.forEach((s) => {
    const ms = chess.moves({ square: s, verbose: true });
    if (ms.length && chess.turn() === userColor)
      dests.set(
        s,
        ms.map((m) => m.to),
      );
  });
  return dests;
}
function getSan(fen, uciMove) {
  if (!uciMove) return "Lance";
  const temp = new Chess(fen);
  const move = temp.move({
    from: uciMove.substring(0, 2),
    to: uciMove.substring(2, 4),
    promotion: uciMove.length > 4 ? uciMove[4] : "q",
  });
  return move ? move.san : uciMove;
}
function parseStockfishInfo(line, fen) {
  const cpMatch = line.match(/score cp (-?\d+)/);
  const mateMatch = line.match(/score mate (-?\d+)/);
  const pvMatch = line.match(/\bpv\s+(.*)/);
  const multiPvMatch = line.match(/multipv (\d+)/);
  const isWhite = fen.includes(" w ");
  let score = 0;
  if (cpMatch)
    score = (isWhite ? parseInt(cpMatch[1]) : -parseInt(cpMatch[1])) / 100;
  else if (mateMatch)
    score = isWhite
      ? parseInt(mateMatch[1]) > 0
        ? 99
        : -99
      : parseInt(mateMatch[1]) > 0
        ? -99
        : 99;
  return {
    score: score,
    pvLine: pvMatch ? pvMatch[1].trim().split(" ") : [],
    multiPvIndex: multiPvMatch ? parseInt(multiPvMatch[1]) : 1,
  };
}
