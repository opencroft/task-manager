// Seam owned by workflows: its schema migrations,
// applied after the core ones by the runner in ../db.ts. Forward-only: never
// edit or reorder an entry once it has shipped; append a new one.

import { randomUUID } from 'node:crypto'

import { defaultTransitionLabel, derivedGate, stepStartedBy } from '../../shared/workflows.ts'
import type { Migration } from '../db.ts'

export const workflowMigrations: Migration[] = [
  {
    id: 'wf-0001-init',
    up(db) {
      db.exec(`
        CREATE TABLE workflow (
          id TEXT PRIMARY KEY,
          name TEXT NOT NULL UNIQUE COLLATE NOCASE,
          description TEXT NOT NULL DEFAULT '',
          is_default INTEGER NOT NULL DEFAULT 0 CHECK (is_default IN (0, 1)),
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL
        );
        -- At most one default per project.
        CREATE UNIQUE INDEX workflow_one_default ON workflow (is_default) WHERE is_default = 1;

        -- A step's statuses are plain ids, not foreign keys: deleting a status
        -- is the task model's operation, and a step left pointing at a removed
        -- status is reported by validation rather than blocking that delete.
        CREATE TABLE workflow_step (
          id TEXT PRIMARY KEY,
          workflow_id TEXT NOT NULL REFERENCES workflow (id) ON DELETE CASCADE,
          position INTEGER NOT NULL,
          name TEXT NOT NULL,
          trigger_status_id INTEGER NOT NULL,
          worker_kind TEXT NOT NULL CHECK (worker_kind IN ('assignee', 'agent')),
          worker_agent_id TEXT,
          chat TEXT NOT NULL,
          instructions TEXT NOT NULL DEFAULT '',
          CHECK ((worker_kind = 'agent') = (worker_agent_id IS NOT NULL)),
          UNIQUE (workflow_id, trigger_status_id)
        );
        CREATE INDEX workflow_step_workflow ON workflow_step (workflow_id, position);

        CREATE TABLE workflow_step_transition (
          step_id TEXT NOT NULL REFERENCES workflow_step (id) ON DELETE CASCADE,
          to_status_id INTEGER NOT NULL,
          position INTEGER NOT NULL,
          PRIMARY KEY (step_id, to_status_id)
        );

        CREATE TABLE workflow_run (
          id TEXT PRIMARY KEY,
          task_id INTEGER NOT NULL REFERENCES task (id) ON DELETE CASCADE,
          workflow_id TEXT REFERENCES workflow (id) ON DELETE SET NULL,
          workflow_name TEXT NOT NULL,
          state TEXT NOT NULL CHECK (state IN ('active', 'finished', 'cancelled')),
          started_by_kind TEXT NOT NULL CHECK (started_by_kind IN ('agent', 'person')),
          started_by_name TEXT NOT NULL,
          started_at TEXT NOT NULL,
          ended_at TEXT
        );
        -- One active run per task.
        CREATE UNIQUE INDEX workflow_run_one_active ON workflow_run (task_id) WHERE state = 'active';
        CREATE INDEX workflow_run_task ON workflow_run (task_id);
        CREATE INDEX workflow_run_state ON workflow_run (state, started_at);

        -- One row per definition step, made when the run starts (and for a step
        -- the definition gained later, when the run first reaches it). The name
        -- is kept so a run still reads right after the step is renamed or removed.
        CREATE TABLE workflow_run_step (
          run_id TEXT NOT NULL REFERENCES workflow_run (id) ON DELETE CASCADE,
          step_id TEXT NOT NULL,
          position INTEGER NOT NULL,
          name TEXT NOT NULL,
          state TEXT NOT NULL DEFAULT 'pending' CHECK (state IN ('pending', 'active', 'waiting', 'done')),
          agent_node_id TEXT,
          agent_name TEXT,
          chat_ref TEXT,
          chat_slug TEXT,
          thread_ref TEXT,
          thread_id TEXT,
          started_at TEXT,
          ended_at TEXT,
          outcome TEXT,
          summary TEXT,
          finished_by TEXT,
          attempts INTEGER NOT NULL DEFAULT 0,
          error TEXT,
          PRIMARY KEY (run_id, step_id)
        );
      `)
    },
  },
  {
    // A run step holds only its latest entry, and a re-entry overwrites it. A
    // round is one entry into a step, kept, so statistics can measure every
    // round's time and count re-entries and the times a step needed attention.
    // A restart in place continues the open round rather than starting one.
    id: 'wf-0002-rounds',
    up(db) {
      db.exec(`
        CREATE TABLE workflow_run_round (
          run_id TEXT NOT NULL REFERENCES workflow_run (id) ON DELETE CASCADE,
          step_id TEXT NOT NULL,
          round_no INTEGER NOT NULL,
          -- Who worked it: the step's agent, or the person it waited on; null while nobody could.
          worker_kind TEXT CHECK (worker_kind IN ('agent', 'person')),
          worker_name TEXT,
          started_at TEXT NOT NULL,
          ended_at TEXT,
          -- 'transition': the task left the step's status; 'cancel': the run was cancelled.
          ended_by TEXT CHECK (ended_by IN ('transition', 'cancel')),
          outcome TEXT,
          -- Times the step could not proceed during this round.
          attention INTEGER NOT NULL DEFAULT 0,
          PRIMARY KEY (run_id, step_id, round_no),
          CHECK ((worker_kind IS NULL) = (worker_name IS NULL)),
          CHECK ((ended_at IS NULL) = (ended_by IS NULL))
        );
        CREATE INDEX workflow_run_workflow ON workflow_run (workflow_id, started_at);

        -- Runs from before this table keep one round per reached step: the
        -- latest entry, numbered by its attempts so a re-entered step still
        -- reads as re-entered. Earlier rounds' times and attention are lost.
        INSERT INTO workflow_run_round
          (run_id, step_id, round_no, worker_kind, worker_name, started_at, ended_at, ended_by, outcome, attention)
        SELECT s.run_id, s.step_id, max(s.attempts, 1),
          CASE WHEN s.agent_name IS NOT NULL THEN 'agent' END, s.agent_name,
          s.started_at, s.ended_at,
          CASE
            WHEN s.ended_at IS NULL THEN NULL
            WHEN r.state = 'cancelled' AND s.ended_at = r.ended_at THEN 'cancel'
            ELSE 'transition'
          END,
          s.outcome,
          CASE WHEN s.error IS NOT NULL THEN 1 ELSE 0 END
        FROM workflow_run_step s JOIN workflow_run r ON r.id = s.run_id
        WHERE s.started_at IS NOT NULL;
      `)
    },
  },
  {
    // What a round's agent session spent, from the chat's own turn records
    // (the host's groupChats.usage), recorded when the round ends. Nothing is
    // asked of the agent. A round that ends mid-turn is 'pending' until that
    // finishing turn has a record, and settles when next read. Rounds with no
    // agent session, and rounds from before this column, keep NULL: no usage.
    id: 'wf-0003-round-usage',
    up(db) {
      db.exec(`
        -- The step session's thread the usage was read from.
        ALTER TABLE workflow_run_round ADD COLUMN thread_ref TEXT;
        ALTER TABLE workflow_run_round ADD COLUMN usage_state TEXT CHECK (usage_state IN ('pending', 'settled'));
        ALTER TABLE workflow_run_round ADD COLUMN usage_turns INTEGER;
        ALTER TABLE workflow_run_round ADD COLUMN tokens_input INTEGER;
        ALTER TABLE workflow_run_round ADD COLUMN tokens_output INTEGER;
        ALTER TABLE workflow_run_round ADD COLUMN tokens_cache_read INTEGER;
        ALTER TABLE workflow_run_round ADD COLUMN tokens_cache_write INTEGER;
        ALTER TABLE workflow_run_round ADD COLUMN tokens_total INTEGER;
        -- JSON [{"amount": 0.12, "currency": "USD"}]: one entry per currency, [] when unpriced.
        ALTER TABLE workflow_run_round ADD COLUMN cost TEXT;
        CREATE INDEX workflow_run_round_pending ON workflow_run_round (usage_state) WHERE usage_state = 'pending';
      `)
    },
  },
  {
    // Every step's session opens in the space's chat, so a step no longer
    // names one. Runs keep chat_ref/chat_slug: they say where each thread IS.
    id: 'wf-0004-space-chat',
    up(db) {
      db.exec('ALTER TABLE workflow_step DROP COLUMN chat')
    },
  },
  {
    // The thread-list folder of the space's chat a step's thread is filed in,
    // by name; '' keeps it at the top level, as every step before this did.
    id: 'wf-0005-step-folder',
    up(db) {
      db.exec("ALTER TABLE workflow_step ADD COLUMN folder TEXT NOT NULL DEFAULT ''")
    },
  },
  {
    // An agent's steps on one task share its thread, so a round's turns are
    // told from the previous round's on that thread, whatever its step. A
    // round's thread_ref is now set when the round starts, and a settled
    // round keeps where its turns stop. Rounds from before keep NULL.
    id: 'wf-0006-shared-thread-rounds',
    up(db) {
      db.exec(`
        -- When the last turn a settled round counted ended, or the round's own end when none ended after it.
        ALTER TABLE workflow_run_round ADD COLUMN usage_until TEXT;
        CREATE INDEX workflow_run_round_thread ON workflow_run_round (thread_ref, started_at);
      `)
    },
  },
  {
    // A settled round that happened inside a turn an earlier round on its
    // thread counted has no figures of its own: it names the step whose round
    // counted that turn instead. Rounds from before keep NULL.
    id: 'wf-0007-round-shared-turn',
    up(db) {
      db.exec('ALTER TABLE workflow_run_round ADD COLUMN usage_shared_with TEXT')
    },
  },
  {
    // The chat command bar's settings a step applies to its session before its
    // message (JSON StepSessionOptions; '{}' changes none, as every step before
    // this did), and what became of them in each round (JSON
    // SessionOptionsOutcome; NULL when the round's message carried none).
    id: 'wf-0008-step-session-options',
    up(db) {
      db.exec(`
        ALTER TABLE workflow_step ADD COLUMN session_options TEXT NOT NULL DEFAULT '{}';
        ALTER TABLE workflow_run_round ADD COLUMN session_options TEXT;
      `)
    },
  },
  {
    // A transition becomes an edge: a label, the step that opens next (NULL
    // ends the run), the status it sets, and a gate override (NULL: derived
    // from the step order). Each status-only transition targets the first
    // step that status starts, or the end when none does, and is labelled
    // from where it leads. Steps may now share a trigger status.
    //
    // Rounds record the transition they ended by and its gate. Ended rounds
    // from before are given them from the outcome status they recorded, by
    // the same rule, where their step still exists. The run holds the move a
    // finishing agent chose until the status change it makes arrives.
    id: 'wf-0009-transition-edges',
    up(db) {
      // Not a foreign key to workflow_step: rebuilding that table below would cascade into it.
      db.exec(`
        CREATE TABLE workflow_transition (
          id TEXT NOT NULL,
          workflow_id TEXT NOT NULL REFERENCES workflow (id) ON DELETE CASCADE,
          step_id TEXT NOT NULL,
          position INTEGER NOT NULL,
          label TEXT NOT NULL,
          to_step_id TEXT,
          status_id INTEGER NOT NULL,
          gate TEXT CHECK (gate IN ('pass', 'fail')),
          PRIMARY KEY (workflow_id, id)
        );
        CREATE INDEX workflow_transition_step ON workflow_transition (step_id, position);
      `)
      const steps = db
        .prepare('SELECT id, workflow_id, name, trigger_status_id FROM workflow_step ORDER BY workflow_id, position')
        .all() as Array<{ id: string; workflow_id: string; name: string; trigger_status_id: number }>
      const statusNames = new Map(
        (db.prepare('SELECT id, name FROM status').all() as Array<{ id: number; name: string }>).map((s) => [
          s.id,
          s.name,
        ]),
      )
      const old = db
        .prepare('SELECT step_id, to_status_id, position FROM workflow_step_transition ORDER BY step_id, position')
        .all() as Array<{ step_id: string; to_status_id: number; position: number }>
      const add = db.prepare(
        'INSERT INTO workflow_transition (id, workflow_id, step_id, position, label, to_step_id, status_id) VALUES (?, ?, ?, ?, ?, ?, ?)',
      )
      for (const t of old) {
        const step = steps.find((s) => s.id === t.step_id)
        if (!step) {
          continue
        }
        const siblings = steps
          .filter((s) => s.workflow_id === step.workflow_id)
          .map((s) => ({ ...s, triggerStatus: s.trigger_status_id }))
        const target = stepStartedBy(siblings, t.to_status_id) ?? null
        const gate = derivedGate(siblings, step.id, target?.id ?? null)
        const label = defaultTransitionLabel(
          gate,
          target ? { step: target.name } : { endStatus: statusNames.get(t.to_status_id) ?? `#${t.to_status_id}` },
        )
        add.run(randomUUID(), step.workflow_id, step.id, t.position, label, target?.id ?? null, t.to_status_id)
      }
      db.exec(`
        DROP TABLE workflow_step_transition;

        CREATE TABLE workflow_step_next (
          id TEXT PRIMARY KEY,
          workflow_id TEXT NOT NULL REFERENCES workflow (id) ON DELETE CASCADE,
          position INTEGER NOT NULL,
          name TEXT NOT NULL,
          trigger_status_id INTEGER NOT NULL,
          worker_kind TEXT NOT NULL CHECK (worker_kind IN ('assignee', 'agent')),
          worker_agent_id TEXT,
          instructions TEXT NOT NULL DEFAULT '',
          folder TEXT NOT NULL DEFAULT '',
          session_options TEXT NOT NULL DEFAULT '{}',
          CHECK ((worker_kind = 'agent') = (worker_agent_id IS NOT NULL))
        );
        INSERT INTO workflow_step_next
          (id, workflow_id, position, name, trigger_status_id, worker_kind, worker_agent_id, instructions, folder, session_options)
        SELECT id, workflow_id, position, name, trigger_status_id, worker_kind, worker_agent_id, instructions, folder, session_options
        FROM workflow_step;
        DROP TABLE workflow_step;
        ALTER TABLE workflow_step_next RENAME TO workflow_step;
        CREATE INDEX workflow_step_workflow ON workflow_step (workflow_id, position);

        ALTER TABLE workflow_run_round ADD COLUMN transition_label TEXT;
        ALTER TABLE workflow_run_round ADD COLUMN gate TEXT CHECK (gate IN ('pass', 'fail'));

        -- The move workflow_step_finish chose, held until its status change arrives.
        ALTER TABLE workflow_run ADD COLUMN pending_status_id INTEGER;
        ALTER TABLE workflow_run ADD COLUMN pending_transition_id TEXT;
        ALTER TABLE workflow_run ADD COLUMN pending_step_id TEXT;
      `)
      const edges = db
        .prepare(
          `SELECT t.step_id, t.label, t.to_step_id, st.name AS status_name FROM workflow_transition t
           JOIN status st ON st.id = t.status_id ORDER BY t.step_id, t.position`,
        )
        .all() as Array<{ step_id: string; label: string; to_step_id: string | null; status_name: string }>
      const ended = db
        .prepare(
          "SELECT rowid, step_id, outcome FROM workflow_run_round WHERE ended_by = 'transition' AND outcome IS NOT NULL",
        )
        .all() as Array<{ rowid: number; step_id: string; outcome: string }>
      const mark = db.prepare('UPDATE workflow_run_round SET transition_label = ?, gate = ? WHERE rowid = ?')
      for (const round of ended) {
        const edge = edges.find((e) => e.step_id === round.step_id && e.status_name === round.outcome)
        const step = steps.find((s) => s.id === round.step_id)
        if (!edge || !step) {
          continue
        }
        const siblings = steps.filter((s) => s.workflow_id === step.workflow_id)
        mark.run(edge.label, derivedGate(siblings, step.id, edge.to_step_id), round.rowid)
      }
    },
  },
  {
    // Approval steps: people approve or reject the task instead of an agent's
    // session working it. Every existing step is an agent step.
    id: 'wf-0010-approval-steps',
    up(db) {
      // Approvers and votes reference steps by plain id, as transitions do: a
      // rebuild of workflow_step must not cascade into them.
      db.exec(`
        ALTER TABLE workflow_step ADD COLUMN kind TEXT NOT NULL DEFAULT 'agent' CHECK (kind IN ('agent', 'approval'));
        ALTER TABLE workflow_step ADD COLUMN approvals_needed INTEGER;

        CREATE TABLE workflow_step_approver (
          workflow_id TEXT NOT NULL REFERENCES workflow (id) ON DELETE CASCADE,
          step_id TEXT NOT NULL,
          position INTEGER NOT NULL,
          person_id TEXT NOT NULL,
          name TEXT NOT NULL,
          required INTEGER NOT NULL CHECK (required IN (0, 1)),
          PRIMARY KEY (step_id, person_id)
        );
        CREATE INDEX workflow_step_approver_workflow ON workflow_step_approver (workflow_id);

        -- One decision per approver per round; a changed decision replaces it.
        CREATE TABLE workflow_run_vote (
          run_id TEXT NOT NULL REFERENCES workflow_run (id) ON DELETE CASCADE,
          step_id TEXT NOT NULL,
          round_no INTEGER NOT NULL,
          person_id TEXT NOT NULL,
          person_name TEXT NOT NULL,
          verdict TEXT NOT NULL CHECK (verdict IN ('approve', 'reject')),
          transition_id TEXT NOT NULL,
          transition_label TEXT NOT NULL,
          comment TEXT,
          at TEXT NOT NULL,
          PRIMARY KEY (run_id, step_id, round_no, person_id)
        );
      `)
    },
  },
  {
    // Why a step couldn't start, once per time it couldn't. A round's
    // `attention` count stays the total: counts from before this table have
    // no rows here, and their reason was never recorded.
    id: 'wf-0011-attention-reasons',
    up(db) {
      db.exec(`
        CREATE TABLE workflow_run_attention (
          run_id TEXT NOT NULL REFERENCES workflow_run (id) ON DELETE CASCADE,
          step_id TEXT NOT NULL,
          round_no INTEGER NOT NULL,
          reason TEXT NOT NULL CHECK (reason IN ('unassigned', 'not_in_chat', 'session_failed')),
          message TEXT NOT NULL,
          at TEXT NOT NULL
        );
        CREATE INDEX workflow_run_attention_run ON workflow_run_attention (run_id, step_id, round_no);
      `)
    },
  },
  {
    // The context a round's session held when the round ended, and the
    // compaction of the session before the round's message (JSON
    // RoundCompaction) with the mark of the process that ran it, which tells
    // a compaction a restart cut off from one still running. Rounds from
    // before have none of them: NULL.
    id: 'wf-0012-round-context',
    up(db) {
      db.exec(`
        ALTER TABLE workflow_run_round ADD COLUMN context_tokens INTEGER;
        ALTER TABLE workflow_run_round ADD COLUMN compaction TEXT;
        ALTER TABLE workflow_run_round ADD COLUMN compaction_process TEXT;
      `)
    },
  },
]
