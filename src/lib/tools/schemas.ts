import { z } from 'zod';

/**
 * ISO 8601 timestamp with an offset.
 *
 * Models reliably produce this shape when asked, and requiring the offset
 * avoids the ambiguity of a bare local time arriving from a model that does not
 * share the user's timezone.
 */
export const isoDateTime = z.iso.datetime({ offset: true });

/** A UUID coming back from a previous tool result. */
export const id = z.string().uuid();
