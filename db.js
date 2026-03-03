const Database = require('better-sqlite3');
const path = require('path');
const fs = require('fs');

// Ensure data directory exists
const dataDir = path.join(__dirname, 'data');
if (!fs.existsSync(dataDir)) {
  fs.mkdirSync(dataDir, { recursive: true });
}

// Initialize database
const db = new Database(path.join(dataDir, 'quizzes.db'));

// Create tables
db.exec(`
  CREATE TABLE IF NOT EXISTS quizzes (
    id TEXT PRIMARY KEY,
    title TEXT NOT NULL,
    description TEXT,
    questions TEXT NOT NULL,
    settings TEXT NOT NULL,
    survey TEXT,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
  );

  CREATE TABLE IF NOT EXISTS survey_results (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    quiz_id TEXT NOT NULL,
    session_code TEXT NOT NULL,
    player_count INTEGER NOT NULL,
    responses TEXT NOT NULL,
    aggregated_results TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    FOREIGN KEY (quiz_id) REFERENCES quizzes(id)
  );

  CREATE INDEX IF NOT EXISTS idx_created_at ON quizzes(created_at DESC);
  CREATE INDEX IF NOT EXISTS idx_survey_quiz ON survey_results(quiz_id, created_at DESC);
`);

// Migration: Add survey column if it doesn't exist
try {
  const tableInfo = db.prepare("PRAGMA table_info(quizzes)").all();
  const hasSurveyColumn = tableInfo.some(col => col.name === 'survey');
  
  if (!hasSurveyColumn) {
    console.log('Running migration: Adding survey column to quizzes table');
    db.exec('ALTER TABLE quizzes ADD COLUMN survey TEXT');
    console.log('Migration completed successfully');
  }
} catch (e) {
  console.error('Migration error:', e);
}

// Prepared statements
const statements = {
  saveQuiz: db.prepare(`
    INSERT INTO quizzes (id, title, description, questions, settings, survey, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(id) DO UPDATE SET
      title = excluded.title,
      description = excluded.description,
      questions = excluded.questions,
      settings = excluded.settings,
      survey = excluded.survey,
      updated_at = excluded.updated_at
  `),

  getQuiz: db.prepare('SELECT * FROM quizzes WHERE id = ?'),

  saveSurveyResults: db.prepare(`
    INSERT INTO survey_results (quiz_id, session_code, player_count, responses, aggregated_results, created_at)
    VALUES (?, ?, ?, ?, ?, ?)
  `),

  getSurveyResults: db.prepare(`
    SELECT * FROM survey_results 
    WHERE quiz_id = ? 
    ORDER BY created_at DESC 
    LIMIT ? OFFSET ?
  `)
};

module.exports = {
  saveQuiz(id, title, description, questions, settings, survey) {
    const now = Date.now();
    statements.saveQuiz.run(
      id,
      title,
      description || '',
      JSON.stringify(questions),
      JSON.stringify(settings),
      survey ? JSON.stringify(survey) : null,
      now,
      now
    );
    return { id, title, description, questions, settings, survey, created_at: now, updated_at: now };
  },

  getQuiz(id) {
    const row = statements.getQuiz.get(id);
    if (!row) return null;
    return {
      id: row.id,
      title: row.title,
      description: row.description,
      questions: JSON.parse(row.questions),
      settings: JSON.parse(row.settings),
      survey: row.survey ? JSON.parse(row.survey) : null,
      created_at: row.created_at,
      updated_at: row.updated_at
    };
  },

  saveSurveyResults(quizId, sessionCode, playerCount, responses, aggregatedResults) {
    const now = Date.now();
    statements.saveSurveyResults.run(
      quizId,
      sessionCode,
      playerCount,
      JSON.stringify(responses),
      JSON.stringify(aggregatedResults),
      now
    );
  },

  getSurveyResults(quizId, limit = 10, offset = 0) {
    const rows = statements.getSurveyResults.all(quizId, limit, offset);
    return rows.map(row => ({
      id: row.id,
      quiz_id: row.quiz_id,
      session_code: row.session_code,
      player_count: row.player_count,
      responses: JSON.parse(row.responses),
      aggregated_results: JSON.parse(row.aggregated_results),
      created_at: row.created_at
    }));
  },

  close() {
    db.close();
  }
};
