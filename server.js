const express = require('express');
const http = require('http');
const WebSocket = require('ws');
const QRCode = require('qrcode');
const { v4: uuidv4 } = require('uuid');
const path = require('path');
const db = require('./db');

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
  
  session.state = 'question';
  session.questionStartTime = Date.now();

  // Clear previous timeout
  if (session.questionTimeout) clearTimeout(session.questionTimeout);

  // Send to host and presentation (original order)
  const hostQuestionData = {
    type: 'question',
    index: session.currentQuestion,
    total: session.questions.length,
    text: q.text,
    options: q.options,
    time: session.settings.questionTime,
    image: q.image || null
  };
  
  sendTo(session.hostWs, hostQuestionData);
  sendTo(session.presentationWs, hostQuestionData);

  // Send to each player (with optional shuffling)
  const shouldShuffle = session.settings.shuffleAnswers !== false; // Default true
  
  session.players.forEach((player, playerId) => {
    let playerOptions = q.options;
    let shuffleMap = null;
    
    if (shouldShuffle) {
      // Create shuffled mapping
      const indices = q.options.map((_, i) => i);
      shuffleMap = shuffleArray([...indices]);
      
      // Store mapping for this player (shuffled index -> original index)
      if (!player.shuffleMaps) player.shuffleMaps = {};
      player.shuffleMaps[session.currentQuestion] = shuffleMap;
      
      // Create shuffled options array
      playerOptions = shuffleMap.map(originalIndex => q.options[originalIndex]);
    }
    
    const playerQuestionData = {
      type: 'question',
      index: session.currentQuestion,
      total: session.questions.length,
      text: q.text,
      options: playerOptions,
      time: session.settings.questionTime,
      image: q.image || null
    };
    
    sendTo(player.ws, playerQuestionData);
  });

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

// Fisher-Yates shuffle
function shuffleArray(array) {
  const arr = [...array];
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  return arr;
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
        session.quizId = msg.quizId || null;
        session.survey = msg.survey || null;
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
        
        console.log(`Join request: name="${msg.name}", session="${session.code}", state="${session.state}"`);
        
        // Check if player with this name already exists (reconnection)
        let existingPlayer = null;
        let existingPlayerId = null;
        session.players.forEach((p, id) => {
          if (p.name === msg.name) {
            existingPlayer = p;
            existingPlayerId = id;
          }
        });
        
        if (existingPlayer) {
          // Reconnection - update WebSocket connection
          console.log(`Reconnection detected for player "${msg.name}"`);
          playerId = existingPlayerId;
          playerSession = session;
          existingPlayer.ws = ws;
          existingPlayer.disconnectedAt = null; // Clear disconnection flag
          
          sendTo(ws, { type: 'joined', playerId, name: msg.name });
          
          // Send current state based on session state
          if (session.state === 'question' && session.currentQuestion >= 0) {
            const q = session.questions[session.currentQuestion];
            const shouldShuffle = session.settings.shuffleAnswers !== false;
            let playerOptions = q.options;
            
            if (shouldShuffle && existingPlayer.shuffleMaps && existingPlayer.shuffleMaps[session.currentQuestion]) {
              const shuffleMap = existingPlayer.shuffleMaps[session.currentQuestion];
              playerOptions = shuffleMap.map(originalIndex => q.options[originalIndex]);
            }
            
            sendTo(ws, {
              type: 'question',
              index: session.currentQuestion,
              total: session.questions.length,
              text: q.text,
              options: playerOptions,
              time: session.settings.questionTime,
              image: q.image || null
            });
          } else if (session.state === 'results') {
            // Player reconnected during results - they'll see it when it's broadcast
          } else if (session.state === 'finished') {
            const leaderboard = getLeaderboard(session);
            sendTo(ws, { type: 'game_over', leaderboard });
          }
          
          console.log(`Player ${msg.name} reconnected to session ${session.code}`);
        } else {
          // New player
          if (session.state !== 'lobby') {
            sendTo(ws, { type: 'error', message: 'Квиз уже идёт' });
            return;
          }
          
          playerId = uuidv4();
          playerSession = session;
          session.players.set(playerId, {
            ws, 
            name: msg.name || 'Аноним', 
            score: 0, 
            answers: {},
            shuffleMaps: {}
          });
          sendTo(ws, { type: 'joined', playerId, name: msg.name });
          
          // Notify host & presentation
          const playerNames = [];
          session.players.forEach(p => playerNames.push(p.name));
          sendTo(session.hostWs, { type: 'player_joined', name: msg.name, count: session.players.size, players: playerNames });
          sendTo(session.presentationWs, { type: 'player_joined', name: msg.name, count: session.players.size, players: playerNames });
        }
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
        
        // Convert shuffled index back to original index
        const shuffleMap = player.shuffleMaps?.[playerSession.currentQuestion];
        const originalIndex = shuffleMap ? shuffleMap[msg.option] : msg.option;
        
        const isCorrect = originalIndex === q.correct;
        const score = calculateScore(isCorrect, elapsed, playerSession.settings.questionTime);

        player.answers[playerSession.currentQuestion] = originalIndex;
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
        
        // Send initial survey count
        sendTo(session.hostWs, {
          type: 'survey_count',
          count: 0,
          total: session.players.size
        });
        sendTo(session.presentationWs, {
          type: 'survey_count',
          count: 0,
          total: session.players.size
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
        
        console.log(`Survey results requested for session ${session.code}, quizId: ${session.quizId}, responses: ${session.surveyResponses.size}`);
        
        // Save results to database if quiz has ID
        if (session.quizId && session.surveyResponses.size > 0) {
          try {
            const responses = [];
            session.surveyResponses.forEach((answers, playerId) => {
              const player = session.players.get(playerId);
              responses.push({
                playerId,
                playerName: player ? player.name : 'Unknown',
                answers
              });
            });
            
            db.saveSurveyResults(
              session.quizId,
              session.code,
              session.players.size,
              responses,
              results
            );
            console.log(`Survey results saved to DB for quiz ${session.quizId}`);
          } catch (e) {
            console.error('Failed to save survey results:', e);
          }
        } else {
          console.log(`Survey results NOT saved: quizId=${session.quizId}, responses=${session.surveyResponses.size}`);
        }
        
        sendTo(ws, { type: 'survey_results', results });
        sendTo(session.presentationWs, { type: 'survey_results', results });
        break;
      }
    }
  });

  ws.on('close', () => {
    if (playerSession && playerId) {
      const player = playerSession.players.get(playerId);
      if (player) {
        // Mark as disconnected instead of deleting immediately
        player.disconnectedAt = Date.now();
        player.ws = null;
        console.log(`Player ${player.name} disconnected from session ${playerSession.code}`);
        
        // Delete after 5 minutes if not reconnected
        setTimeout(() => {
          const p = playerSession.players.get(playerId);
          if (p && p.disconnectedAt && !p.ws) {
            playerSession.players.delete(playerId);
            console.log(`Player ${p.name} removed after timeout`);
            const playerNames = [];
            playerSession.players.forEach(pl => playerNames.push(pl.name));
            sendTo(playerSession.hostWs, { type: 'player_left', count: playerSession.players.size, players: playerNames });
            sendTo(playerSession.presentationWs, { type: 'player_left', count: playerSession.players.size, players: playerNames });
          }
        }, 5 * 60 * 1000); // 5 minutes
      }
    }
  });
});

// ── Quiz CRUD API ──────────────────────────────────────
// Save quiz
app.post('/api/quizzes', (req, res) => {
  try {
    const { id, title, description, questions, settings, survey } = req.body;
    if (!title || !questions || questions.length === 0) {
      return res.status(400).json({ error: 'Title and questions are required' });
    }
    const quizId = id || uuidv4();
    const quiz = db.saveQuiz(quizId, title, description, questions, settings || { questionTime: 20 }, survey);
    res.json({ success: true, quiz });
  } catch (e) {
    console.error('Save quiz error:', e);
    res.status(500).json({ error: 'Failed to save quiz' });
  }
});

// Get quiz by ID
app.get('/api/quizzes/:id', (req, res) => {
  try {
    const quiz = db.getQuiz(req.params.id);
    if (!quiz) {
      return res.status(404).json({ error: 'Quiz not found' });
    }
    res.json(quiz);
  } catch (e) {
    console.error('Get quiz error:', e);
    res.status(500).json({ error: 'Failed to load quiz' });
  }
});

// Get survey results for quiz
app.get('/api/quizzes/:id/survey-results', (req, res) => {
  try {
    const limit = parseInt(req.query.limit) || 10;
    const offset = parseInt(req.query.offset) || 0;
    const results = db.getSurveyResults(req.params.id, limit, offset);
    res.json(results);
  } catch (e) {
    console.error('Get survey results error:', e);
    res.status(500).json({ error: 'Failed to load survey results' });
  }
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
