import type { PipelineStage } from 'mongoose';
import { z } from 'zod';

export const MAX_LIMIT = 100;
export const DEFAULT_LIMIT = 10;
/** Caps skip depth: page * limit beyond this is better served by cursor pagination. */
export const MAX_PAGE = 10_000;

export type SortOrder = 'asc' | 'desc';

export interface PaginationParams<TSort extends string = string> {
  page: number;
  limit: number;
  sortBy: TSort;
  sortOrder: SortOrder;
}

export interface PaginationMeta {
  currentPage: number;
  limit: number;
  totalRecords: number;
  totalPages: number;
  hasNextPage: boolean;
  hasPreviousPage: boolean;
}

/**
 * Builds a Zod schema for `page`, `limit`, `sortBy`, `sortOrder` query params.
 * `sortBy` is restricted to an allow-list per endpoint so that every accepted
 * sort can be served by an index (or is explicitly documented as in-memory).
 */
export function paginationQuerySchema<const TSort extends readonly [string, ...string[]]>(
  sortFields: TSort,
  defaults: { sortBy: TSort[number]; sortOrder: SortOrder },
) {
  return z.object({
    page: z.coerce.number().int().min(1).max(MAX_PAGE).default(1),
    limit: z.coerce.number().int().min(1).max(MAX_LIMIT).default(DEFAULT_LIMIT),
    sortBy: z.enum(sortFields).default(defaults.sortBy),
    sortOrder: z.enum(['asc', 'desc']).default(defaults.sortOrder),
  });
}

export function getSkip({ page, limit }: Pick<PaginationParams, 'page' | 'limit'>): number {
  return (page - 1) * limit;
}

/** MongoDB sort direction for an index walk: 1 = ascending, -1 = descending. */
export function sortDirection(order: SortOrder): 1 | -1 {
  return order === 'asc' ? 1 : -1;
}

export function buildPaginationMeta(
  { page, limit }: Pick<PaginationParams, 'page' | 'limit'>,
  totalRecords: number,
): PaginationMeta {
  const totalPages = Math.ceil(totalRecords / limit);
  return {
    currentPage: page,
    limit,
    totalRecords,
    totalPages,
    hasNextPage: page < totalPages,
    hasPreviousPage: page > 1,
  };
}

/** Shape produced by a `$facet` with `metadata: [{ $count: 'totalRecords' }]` and `data`. */
export interface FacetResult<T> {
  metadata: { totalRecords: number }[];
  data: T[];
}

/** Unwraps the single document returned by a `$facet` pagination stage. */
export function unwrapFacet<T>(result: FacetResult<T>[]): { data: T[]; totalRecords: number } {
  const facet = result[0];
  return {
    data: facet?.data ?? [],
    totalRecords: facet?.metadata[0]?.totalRecords ?? 0,
  };
}

/** Standard `$facet` stage: total count plus one page of data, in a single aggregate call. */
export function paginationFacet(
  params: Pick<PaginationParams, 'page' | 'limit'>,
  dataStages: PipelineStage.FacetPipelineStage[] = [],
): PipelineStage.Facet {
  return {
    $facet: {
      metadata: [{ $count: 'totalRecords' }],
      data: [{ $skip: getSkip(params) }, { $limit: params.limit }, ...dataStages],
    },
  };
}
