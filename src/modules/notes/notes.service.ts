import { Types } from 'mongoose';
import type { AuthContext } from '../../middleware/authenticate.js';
import { Note, type INote } from '../../models/Note.model.js';
import { ApiError } from '../../utils/ApiError.js';
import { buildPaginationMeta, type PaginationMeta } from '../../utils/pagination.js';
import {
  buildNoteCountQuery,
  buildNoteListQuery,
  noteReadFilter,
  noteWriteFilter,
} from './notes.queries.js';
import type { CreateNoteInput, ListNotesQuery, UpdateNoteInput } from './notes.schemas.js';

export interface NoteDTO {
  id: string;
  title: string;
  content: string;
  user: string;
  createdAt: Date;
  updatedAt: Date;
}

function toNoteDTO(note: INote & { _id: Types.ObjectId }): NoteDTO {
  return {
    id: note._id.toString(),
    title: note.title,
    content: note.content,
    user: note.user.toString(),
    createdAt: note.createdAt,
    updatedAt: note.updatedAt,
  };
}

// 404 (not 403) for notes outside the caller's scope: does not reveal that the id exists.
const NOTE_NOT_FOUND = 'Note not found';

const isAdmin = (actor: AuthContext) => actor.role === 'admin';
const ownerOf = (actor: AuthContext) => new Types.ObjectId(actor.userId);

export async function createNote(actor: AuthContext, input: CreateNoteInput): Promise<NoteDTO> {
  // Owner comes from the verified token, never from the request body.
  const note = await Note.create({ ...input, user: ownerOf(actor) });
  return toNoteDTO(note);
}

/**
 * Resolves whose notes are listed:
 *  - user: always themselves (passing another user's id is forbidden)
 *  - admin: everyone, or a single user via ?userId=
 */
function resolveListOwner(
  actor: AuthContext,
  requested?: Types.ObjectId,
): Types.ObjectId | undefined {
  if (isAdmin(actor)) return requested;
  if (requested && !requested.equals(actor.userId)) {
    throw ApiError.forbidden("You cannot list another user's notes");
  }
  return ownerOf(actor);
}

export async function listNotes(
  actor: AuthContext,
  query: ListNotesQuery,
): Promise<{ notes: NoteDTO[]; pagination: PaginationMeta }> {
  const owner = resolveListOwner(actor, query.userId);
  const [notes, totalRecords] = await Promise.all([
    buildNoteListQuery(owner, query),
    buildNoteCountQuery(owner),
  ]);
  return { notes: notes.map(toNoteDTO), pagination: buildPaginationMeta(query, totalRecords) };
}

export async function getNote(actor: AuthContext, noteId: Types.ObjectId): Promise<NoteDTO> {
  const owner = isAdmin(actor) ? undefined : ownerOf(actor);
  const note = await Note.findOne(noteReadFilter(noteId, owner)).lean();
  if (!note) throw ApiError.notFound(NOTE_NOT_FOUND);
  return toNoteDTO(note);
}

export async function updateNote(
  actor: AuthContext,
  noteId: Types.ObjectId,
  input: UpdateNoteInput,
): Promise<NoteDTO> {
  // Ownership check and update are one atomic operation (no read-then-write race).
  const note = await Note.findOneAndUpdate(
    noteWriteFilter(noteId, ownerOf(actor)),
    { $set: input },
    { returnDocument: 'after', runValidators: true },
  ).lean();
  if (!note) throw ApiError.notFound(NOTE_NOT_FOUND);
  return toNoteDTO(note);
}

export async function deleteNote(actor: AuthContext, noteId: Types.ObjectId): Promise<void> {
  const { deletedCount } = await Note.deleteOne(noteWriteFilter(noteId, ownerOf(actor)));
  if (deletedCount === 0) throw ApiError.notFound(NOTE_NOT_FOUND);
}
