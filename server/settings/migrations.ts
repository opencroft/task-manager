// Seam owned by project settings: its schema migrations, applied after the
// mentions' by the runner in ../db.ts. Forward-only: never edit or reorder an
// entry once it has shipped; append a new one.

import type { Migration } from '../db.ts'

export const settingsMigrations: Migration[] = [
  {
    id: 'settings-0001-label-color',
    up(db) {
      db.exec(`
        -- A label's colour, by the label's exact name; a label without a row has
        -- none. Labels themselves stay plain strings in task_label.
        CREATE TABLE label_color (
          name TEXT PRIMARY KEY,
          color TEXT NOT NULL
        );
      `)
    },
  },
]
