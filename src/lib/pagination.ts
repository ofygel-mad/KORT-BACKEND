import { z } from 'zod';

export const paginationSchema = z.object({
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(100).optional(),
  page_size: z.coerce.number().int().min(1).max(100).optional(),
}).transform((value) => ({
  page: value.page,
  limit: value.limit ?? value.page_size ?? 25,
}));

export type PaginationParams = z.infer<typeof paginationSchema>;

export function paginate(params: PaginationParams) {
  return {
    skip: (params.page - 1) * params.limit,
    take: params.limit,
  };
}

export function paginatedResponse<T>(items: T[], total: number, params: PaginationParams) {
  return {
    count: total,
    page: params.page,
    limit: params.limit,
    totalPages: Math.ceil(total / params.limit),
    results: items,
  };
}
