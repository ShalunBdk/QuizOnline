const express = require('express');
const http = require('http');
const WebSocket = require('ws');
const QRCode = require('qrcode');
const { v4: uuidv4 } = require('uuid');
const path = require('path');

const app = express();
const server = http.createServer(app);
const wss = new WebSocket.Server({ server });

app.use(express.static(path.join(__dirname, 'public')));
app.use(express.json());

// ── State ──────────────────────────────────────────────
const sessions = new Map(); // sessionId -> session

function createSession(hostWs) {
  const code = Math.random().toString(36).substring(2, 8).toUpperCase();
  const session = {
    id: uuidv4(),
    code,
    hostWs,
    presentationWs: null,
    state: 'lobby', // lobby | question | results | leaderboard | finished
    players: new Map(), // odlayerId -> { ws, name, score, answers }
    questions: [],
    currentQuestion: -1,
    questionStartTime: null,
    questionTimeout: null,
    settings: { questionTime: 20 },
    survey: null, // { questions: [...] }
    surveyResponses: new Map() // playerId -> { answers }
  };
  sessions.set(code, session);
  return session;
}

function getLeaderboard(session) {
  const players = [];
  session.players.forEach((p, id) => {
    players.push({ id, name: p.name, score: p.score });
  });
  players.sort((a, b) => b.score - a.score);
  return players;
}

function broadcast(session, msg, exclude) {
  const data = JSON.stringify(msg);
  session.players.forEach((p) => {
    if (p.ws !== exclude && p.ws.readyState === WebSocket.OPEN) {
      p.ws.send(data);
    }
  });
  // Also send to host
  if (session.hostWs && session.hostWs !== exclude && session.hostWs.readyState === WebSocket.OPEN) {
    session.hostWs.send(data);
  }
  // Also send to presentation screen
  if (session.presentationWs && session.presentationWs !== exclude && session.presentationWs.readyState === WebSocket.OPEN) {
    session.presentationWs.send(data);
  }
}

function sendTo(ws, msg) {
  if (ws && ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify(msg));
  }
}

function calculateScore(isCorrect, timeElapsed, maxTime) {
  if (!isCorrect) return 0;
  const timeBonus = Math.max(0, 1 - timeElapsed / (maxTime * 1000));
  return Math.round(500 + 500 * timeBonus); // 500-1000 points
}

function sendQuestion(session) {
  const q = session.questions[session.currentQuestion];
  const questionData = {
    type: 'question',
    index: session.currentQuestion,
    total: session.questions.length,
    text: q.text,
    options: q.options,
    time: session.settings.questionTime,
    image: q.image || null
  };

  session.state = 'question';
  session.questionStartTime = Date.now();

  // Clear previous timeout
  if (session.questionTimeout) clearTimeout(session.questionTimeout);

  broadcast(session, questionData);

  // Send initial answer count
  sendTo(session.hostWs, {
    type: 'answer_count',
    answered: 0,
    total: session.players.size
  });
  sendTo(session.presentationWs, {
    type: 'answer_count',
    answered: 0,
    total: session.players.size
  });

  // Auto-end question after time
  session.questionTimeout = setTimeout(() => {
    endQuestion(session);
  }, session.settings.questionTime * 1000 + 1000); // +1s buffer
}

function endQuestion(session) {
  if (session.state !== 'question') return;
  session.state = 'results';

  if (session.questionTimeout) {
    clearTimeout(session.questionTimeout);
    session.questionTimeout = null;
  }

  const q = session.questions[session.currentQuestion];
  const answeredCount = { total: 0, correct: 0, perOption: new Array(q.options.length).fill(0) };

  session.players.forEach((p) => {
    const answer = p.answers[session.currentQuestion];
    if (answer !== undefined) {
      answeredCount.total++;
      answeredCount.perOption[answer]++;
      if (answer === q.correct) answeredCount.correct++;
    }
  });

  broadcast(session, {
    type: 'question_results',
    correctIndex: q.correct,
    explanation: q.explanation || null,
    stats: answeredCount,
    leaderboard: getLeaderboard(session).slice(0, 5)
  });
}

function nextQuestion(session) {
  session.currentQuestion++;
  if (session.currentQuestion >= session.questions.length) {
    session.state = 'finished';
    broadcast(session, {
      type: 'game_over',
      leaderboard: getLeaderboard(session)
    });
    return;
  }
  sendQuestion(session);
}

// ── Survey Aggregation ─────────────────────────────────
function aggregateSurvey(session) {
  if (!session.survey) return [];
  const questions = session.survey.questions;
  const results = questions.map((q, qi) => {
    if (q.type === 'rating') {
      const ratings = [];
      session.surveyResponses.forEach(answers => {
        if (answers[qi] !== undefined) ratings.push(answers[qi]);
      });
      const avg = ratings.length > 0 ? (ratings.reduce((a, b) => a + b, 0) / ratings.length).toFixed(1) : 0;
      return { ...q, ratings, average: parseFloat(avg), count: ratings.length };
    } else if (q.type === 'multi_choice') {
      const counts = {};
      q.options.forEach(o => counts[o] = 0);
      session.surveyResponses.forEach(answers => {
        const selected = answers[qi] || [];
        selected.forEach(s => { if (counts[s] !== undefined) counts[s]++; });
      });
      return { ...q, counts, total: session.surveyResponses.size };
    } else if (q.type === 'text') {
      const texts = [];
      session.surveyResponses.forEach(answers => {
        if (answers[qi] && answers[qi].trim()) texts.push(answers[qi].trim());
      });
      return { ...q, responses: texts };
    }
    return q;
  });
  return results;
}

// ── WebSocket ──────────────────────────────────────────
wss.on('connection', (ws) => {
  let playerSession = null;
  let playerId = null;

  ws.on('message', (raw) => {
    let msg;
    try { msg = JSON.parse(raw); } catch { return; }

    switch (msg.type) {
      // Host creates session
      case 'create_session': {
        const session = createSession(ws);
        session.questions = msg.questions || [];
        if (msg.settings) {
          session.settings = { ...session.settings, ...msg.settings };
        }
        sendTo(ws, { type: 'session_created', code: session.code, id: session.id });
        break;
      }

      // Presentation screen joins
      case 'join_presentation': {
        const session = sessions.get(msg.code?.toUpperCase());
        if (!session) {
          sendTo(ws, { type: 'error', message: 'Сессия не найдена' });
          return;
        }
        session.presentationWs = ws;
        playerSession = session;
        const playerNames = [];
        session.players.forEach(p => playerNames.push(p.name));
        sendTo(ws, { type: 'presentation_joined', code: session.code, players: playerNames });
        break;
      }

      // Player joins
      case 'join': {
        const session = sessions.get(msg.code?.toUpperCase());
        if (!session) {
          sendTo(ws, { type: 'error', message: 'Сессия не найдена' });
          return;
        }
        if (session.state !== 'lobby') {
          sendTo(ws, { type: 'error', message: 'Квиз уже идёт' });
          return;
        }
        playerId = uuidv4();
        playerSession = session;
        session.players.set(playerId, {
          ws, name: msg.name || 'Аноним', score: 0, answers: {}
        });
        sendTo(ws, { type: 'joined', playerId, name: msg.name });
        // Notify host & presentation
        const playerNames = [];
        session.players.forEach(p => playerNames.push(p.name));
        sendTo(session.hostWs, { type: 'player_joined', name: msg.name, count: session.players.size, players: playerNames });
        sendTo(session.presentationWs, { type: 'player_joined', name: msg.name, count: session.players.size, players: playerNames });
        break;
      }

      // Host starts the quiz
      case 'start_quiz': {
        const session = sessions.get(msg.code?.toUpperCase());
        if (!session || session.hostWs !== ws) return;
        if (session.questions.length === 0) {
          sendTo(ws, { type: 'error', message: 'Добавьте вопросы' });
          return;
        }
        session.currentQuestion = -1;
        nextQuestion(session);
        break;
      }

      // Host moves to next question
      case 'next_question': {
        const session = sessions.get(msg.code?.toUpperCase());
        if (!session || session.hostWs !== ws) return;
        nextQuestion(session);
        break;
      }

      // Host ends current question early
      case 'end_question': {
        const session = sessions.get(msg.code?.toUpperCase());
        if (!session || session.hostWs !== ws) return;
        endQuestion(session);
        break;
      }

      // Player answers
      case 'answer': {
        if (!playerSession || !playerId) return;
        if (playerSession.state !== 'question') return;
        const player = playerSession.players.get(playerId);
        if (!player) return;
        if (player.answers[playerSession.currentQuestion] !== undefined) return; // already answered

        const q = playerSession.questions[playerSession.currentQuestion];
        const elapsed = Date.now() - playerSession.questionStartTime;
        const isCorrect = msg.option === q.correct;
        const score = calculateScore(isCorrect, elapsed, playerSession.settings.questionTime);

        player.answers[playerSession.currentQuestion] = msg.option;
        player.score += score;

        sendTo(ws, {
          type: 'answer_result',
          correct: isCorrect,
          score,
          totalScore: player.score
        });

        // Notify host, presentation and all players of answer count
        let answeredCount = 0;
        playerSession.players.forEach(p => {
          if (p.answers[playerSession.currentQuestion] !== undefined) answeredCount++;
        });
        
        const countMsg = {
          type: 'answer_count',
          answered: answeredCount,
          total: playerSession.players.size
        };
        
        sendTo(playerSession.hostWs, countMsg);
        sendTo(playerSession.presentationWs, countMsg);
        
        // Send to all players who already answered
        playerSession.players.forEach((p) => {
          if (p.answers[playerSession.currentQuestion] !== undefined) {
            sendTo(p.ws, countMsg);
          }
        });

        // Auto-end if all answered
        if (answeredCount === playerSession.players.size) {
          endQuestion(playerSession);
        }
        break;
      }

      // Host updates questions mid-lobby
      case 'update_questions': {
        const session = sessions.get(msg.code?.toUpperCase());
        if (!session || session.hostWs !== ws) return;
        session.questions = msg.questions || [];
        if (msg.settings) {
          session.settings = { ...session.settings, ...msg.settings };
        }
        sendTo(ws, { type: 'questions_updated', count: session.questions.length });
        break;
      }

      // Host starts survey after quiz
      case 'start_survey': {
        const session = sessions.get(msg.code?.toUpperCase());
        if (!session || session.hostWs !== ws) return;
        session.survey = msg.survey || null;
        session.surveyResponses = new Map();
        broadcast(session, {
          type: 'survey',
          questions: session.survey.questions
        });
        break;
      }

      // Player submits survey
      case 'survey_response': {
        if (!playerSession || !playerId) return;
        if (!playerSession.survey) return;
        if (playerSession.surveyResponses.has(playerId)) return;
        playerSession.surveyResponses.set(playerId, msg.answers);
        sendTo(ws, { type: 'survey_submitted' });

        // Notify host of response count
        sendTo(playerSession.hostWs, {
          type: 'survey_count',
          count: playerSession.surveyResponses.size,
          total: playerSession.players.size
        });
        sendTo(playerSession.presentationWs, {
          type: 'survey_count',
          count: playerSession.surveyResponses.size,
          total: playerSession.players.size
        });

        // If all responded, send aggregated results
        if (playerSession.surveyResponses.size === playerSession.players.size) {
          const results = aggregateSurvey(playerSession);
          sendTo(playerSession.hostWs, { type: 'survey_results', results });
          sendTo(playerSession.presentationWs, { type: 'survey_results', results });
        }
        break;
      }

      // Host requests survey results
      case 'get_survey_results': {
        const session = sessions.get(msg.code?.toUpperCase());
        if (!session || session.hostWs !== ws) return;
        const results = aggregateSurvey(session);
        sendTo(ws, { type: 'survey_results', results });
        sendTo(session.presentationWs, { type: 'survey_results', results });
        break;
      }
    }
  });

  ws.on('close', () => {
    if (playerSession && playerId) {
      playerSession.players.delete(playerId);
      const playerNames = [];
      playerSession.players.forEach(p => playerNames.push(p.name));
      sendTo(playerSession.hostWs, { type: 'player_left', count: playerSession.players.size, players: playerNames });
      sendTo(playerSession.presentationWs, { type: 'player_left', count: playerSession.players.size, players: playerNames });
    }
  });
});

// ── QR Code endpoint ───────────────────────────────────
app.get('/api/qr/:code', async (req, res) => {
  try {
    const url = `${req.protocol}://${req.get('host')}/play?code=${req.params.code}`;
    const qr = await QRCode.toDataURL(url, { width: 400, margin: 2, color: { dark: '#000', light: '#fff' } });
    res.json({ qr, url });
  } catch (e) {
    res.status(500).json({ error: 'QR generation failed' });
  }
});

// ── SPA fallback ───────────────────────────────────────
app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`🎮 Quiz Platform running on http://localhost:${PORT}`);
  console.log(`   Host:    http://localhost:${PORT}/host`);
  console.log(`   Play:    http://localhost:${PORT}/play`);
  console.log(`   Screen:  http://localhost:${PORT}/screen`);
});
