import { Router } from 'express';
import { authenticate } from '../../middleware/authenticate.js';
import { validated } from '../../middleware/validate.js';
import { idParamsSchema } from '../../utils/validators.js';
import * as notesController from './notes.controller.js';
import { createNoteSchema, listNotesQuerySchema, updateNoteSchema } from './notes.schemas.js';

export function createNotesRouter(): Router {
  const router = Router();
  router.use(authenticate);

  router.post('/', validated({ body: createNoteSchema }, notesController.create));
  router.get('/', validated({ query: listNotesQuerySchema }, notesController.list));
  router.get('/:id', validated({ params: idParamsSchema }, notesController.get));
  router.patch(
    '/:id',
    validated({ params: idParamsSchema, body: updateNoteSchema }, notesController.update),
  );
  router.delete('/:id', validated({ params: idParamsSchema }, notesController.remove));

  return router;
}
