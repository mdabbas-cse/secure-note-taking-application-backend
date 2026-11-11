import { requireAuth } from '../../middleware/authenticate.js';
import type { ValidatedHandler } from '../../middleware/validate.js';
import { sendSuccess } from '../../utils/response.js';
import type { idParamsSchema } from '../../utils/validators.js';
import type { createNoteSchema, listNotesQuerySchema, updateNoteSchema } from './notes.schemas.js';
import * as notesService from './notes.service.js';

type IdParams = { params: typeof idParamsSchema };

export const create: ValidatedHandler<{ body: typeof createNoteSchema }> = async (
  { body },
  req,
  res,
) => {
  const note = await notesService.createNote(requireAuth(req), body);
  sendSuccess(res, { statusCode: 201, message: 'Note created successfully', data: note });
};

export const list: ValidatedHandler<{ query: typeof listNotesQuerySchema }> = async (
  { query },
  req,
  res,
) => {
  const { notes, pagination } = await notesService.listNotes(requireAuth(req), query);
  sendSuccess(res, { message: 'Notes retrieved successfully', data: notes, pagination });
};

export const get: ValidatedHandler<IdParams> = async ({ params }, req, res) => {
  const note = await notesService.getNote(requireAuth(req), params.id);
  sendSuccess(res, { message: 'Note retrieved successfully', data: note });
};

export const update: ValidatedHandler<IdParams & { body: typeof updateNoteSchema }> = async (
  { params, body },
  req,
  res,
) => {
  const note = await notesService.updateNote(requireAuth(req), params.id, body);
  sendSuccess(res, { message: 'Note updated successfully', data: note });
};

export const remove: ValidatedHandler<IdParams> = async ({ params }, req, res) => {
  await notesService.deleteNote(requireAuth(req), params.id);
  sendSuccess(res, { message: 'Note deleted successfully' });
};
