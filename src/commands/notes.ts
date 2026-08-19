/**
 * ─────────────────────────────────────────────────────────────────────────────
 *  THE WORKED EXAMPLE. Copy this file, rename it, delete the original.
 * ─────────────────────────────────────────────────────────────────────────────
 *
 * A command that does what most commands do: authenticate, call an API, and
 * render the result two ways — as a table for a person and as JSON for a
 * script. Everything else in `src/commands/` is framework plumbing (login,
 * doctor); this is the shape of the code you will actually write.
 *
 * It talks to the mock server, so it runs end to end today:
 *
 *     npm run mock-server          # terminal 1
 *     npm run acme -- login         # terminal 2
 *     npm run acme -- notes
 *     npm run acme -- notes --status draft --json | jq -r '.notes[].id'
 *
 * The data is invented. It is not a real service, and deliberately not a public
 * API either — an example that depends on somebody else's endpoint rots the
 * first time they change it, and it would drag a network call into a test suite
 * that otherwise has none.
 *
 * `npm run rebrand` offers to delete this file and its tests.
 */

import { defineCommand } from '../core/command.ts';
import { NotFoundError } from '../core/errors.ts';
import { definitionList, plural, table } from '../core/render.ts';
import { openSession } from './session.ts';

interface Note {
  id: string;
  title: string;
  status: 'draft' | 'scheduled' | 'published';
  views: number;
}

const STATUSES = ['draft', 'scheduled', 'published'];

export const notesCommand = defineCommand({
  name: 'notes',
  aliases: ['n'],
  // A fragment, not a sentence, and no full stop — it appears in a list
  // alongside every other command. There is a test for that.
  summary: 'list your notes',
  description:
    'Lists your notes, newest first. Pass an id to show a single note. ' +
    'Use --json to get machine-readable output for a script.',

  args: [{ name: 'id', summary: 'show one note instead of the list' }],

  flags: {
    status: {
      type: 'string',
      placeholder: '<status>',
      // Describe the effect, not the name. "filter by status" tells the reader
      // nothing they could not guess from the flag itself.
      summary: 'show only notes with this status',
      choices: STATUSES,
    },
  },

  examples: [
    { cmd: 'notes', note: 'everything, newest first' },
    { cmd: 'notes --status draft', note: 'what has not gone out yet' },
    { cmd: 'notes n_8f21', note: 'one note in full' },
    { cmd: 'notes --json | jq -r ".notes[].id"', note: 'ids, for a script' },
  ],

  async run(ctx) {
    // `require: true` turns "not signed in" into exit code 4 with a "run
    // `acme login`" hint, instead of an unexplained 401 further down.
    const session = await openSession(ctx, { require: true });
    const [id] = ctx.args;

    if (id !== undefined) {
      const { note } = await session.http
        .get<{ note: Note }>(`/api/v1/notes/${encodeURIComponent(id)}`)
        .catch((error: unknown) => {
          // The client already turns a 404 into NotFoundError; re-throwing it
          // here only adds the hint, which is the part people act on.
          if (error instanceof NotFoundError) {
            throw new NotFoundError('note.not_found', `No note with id ${id}.`, {
              hint: `Run \`${ctx.program.name} notes\` to see the ids you have.`,
              details: { id },
            });
          }
          throw error;
        });

      ctx.emit({ ok: true, note });
      if (ctx.globals.json) return;

      for (const line of definitionList(
        [
          { term: 'id', description: ctx.theme.muted(note.id) },
          { term: 'title', description: note.title },
          { term: 'status', description: note.status },
          { term: 'views', description: note.views.toLocaleString('en-US') },
        ],
        ctx.theme,
      )) {
        ctx.out(line);
      }
      return;
    }

    const status = ctx.flags.string('status');
    const { notes } = await session.http.get<{ notes: Note[] }>('/api/v1/notes', {
      // Undefined keys are dropped, and values are encoded properly — do not
      // build query strings by concatenation.
      query: { status },
    });

    // Always emit, always exactly once. Without this the command produces
    // nothing at all under --json.
    ctx.emit({ ok: true, notes });
    if (ctx.globals.json) return;

    if (notes.length === 0) {
      // An empty result is not an error. Say so plainly and exit 0, so a
      // script can tell "none" from "something went wrong".
      ctx.say(
        ctx.theme.muted(
          status === undefined ? 'No notes yet.' : `No notes with status "${status}".`,
        ),
      );
      return;
    }

    const glyph = (note: Note): string => {
      if (note.status === 'published') return ctx.theme.success(ctx.theme.glyph.tick);
      if (note.status === 'scheduled') return ctx.theme.warning(ctx.theme.glyph.bullet);
      return ctx.theme.muted(ctx.theme.glyph.dot);
    };

    // The table goes to stdout because it is the data. The count goes to
    // stderr because it is commentary — that split is what keeps
    // `notes | grep` and `notes --json | jq` both honest.
    for (const line of table(
      [{ header: '' }, { header: 'ID' }, { header: 'TITLE' }, { header: 'VIEWS', align: 'right' }],
      notes.map((note) => [
        glyph(note),
        ctx.theme.muted(note.id),
        note.title,
        // A plain dash, not glyph.dot — that is already the draft status
        // marker in the first column, and reusing it here reads as data.
        note.views === 0 ? ctx.theme.muted('-') : note.views.toLocaleString('en-US'),
      ]),
      ctx.theme,
    )) {
      ctx.out(line);
    }

    ctx.say('');
    ctx.say(ctx.theme.muted(plural(notes.length, 'note')));
  },
});
