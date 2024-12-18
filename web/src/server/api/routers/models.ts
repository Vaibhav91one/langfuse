import { z } from "zod";

import { ModelUsageUnit } from "@langfuse/shared";
import { throwIfNoProjectAccess } from "@/src/features/rbac/utils/checkProjectAccess";
import {
  createTRPCRouter,
  protectedProjectProcedure,
} from "@/src/server/api/trpc";
import { paginationZod } from "@langfuse/shared";
import { TRPCError } from "@trpc/server";
import { auditLog } from "@/src/features/audit-logs/auditLog";
import { isValidPostgresRegex } from "@/src/features/models/server/isValidPostgresRegex";

const ModelAllOptions = z.object({
  projectId: z.string(),
  ...paginationZod,
});

export const modelRouter = createTRPCRouter({
  all: protectedProjectProcedure
    .input(ModelAllOptions)
    .query(async ({ input, ctx }) => {
      const [models, totalAmount] = await Promise.all([
        ctx.prisma.model.findMany({
          where: {
            OR: [{ projectId: input.projectId }, { projectId: null }],
          },
          skip: input.page * input.limit,
          orderBy: [
            { modelName: "asc" },
            { unit: "asc" },
            {
              startDate: {
                sort: "desc",
                nulls: "last",
              },
            },
          ],
          take: input.limit,
        }),
        ctx.prisma.model.count({
          where: {
            OR: [{ projectId: input.projectId }, { projectId: null }],
          },
        }),
      ]);
      return {
        models,
        totalCount: totalAmount,
      };
    }),
  modelNames: protectedProjectProcedure
    .input(z.object({ projectId: z.string() }))
    .query(async ({ input, ctx }) => {
      return (
        await ctx.prisma.model.findMany({
          select: {
            modelName: true,
          },
          distinct: ["modelName"],
          orderBy: [{ modelName: "asc" }],
          where: {
            OR: [{ projectId: input.projectId }, { projectId: null }],
          },
        })
      ).map((model) => model.modelName);
    }),
  delete: protectedProjectProcedure
    .input(
      z.object({
        projectId: z.string(),
        modelId: z.string(),
      }),
    )
    .mutation(async ({ input, ctx }) => {
      throwIfNoProjectAccess({
        session: ctx.session,
        projectId: input.projectId,
        scope: "models:CUD",
      });

      const deletedModel = await ctx.prisma.model.delete({
        where: {
          id: input.modelId,
          projectId: input.projectId,
        },
      });

      await auditLog({
        session: ctx.session,
        resourceType: "model",
        resourceId: input.modelId,
        action: "delete",
        before: deletedModel,
      });

      return deletedModel;
    }),
  create: protectedProjectProcedure
    .input(
      z.object({
        projectId: z.string(),
        modelName: z.string(),
        matchPattern: z.string(),
        startDate: z.date().optional(),
        inputPrice: z.number().nonnegative().optional(),
        outputPrice: z.number().nonnegative().optional(),
        totalPrice: z.number().nonnegative().optional(),
        unit: z.nativeEnum(ModelUsageUnit),
        tokenizerId: z.enum(["openai", "claude"]).optional(),
        tokenizerConfig: z.record(z.union([z.string(), z.number()])).optional(),
      }),
    )
    .mutation(async ({ input, ctx }) => {
      throwIfNoProjectAccess({
        session: ctx.session,
        projectId: input.projectId,
        scope: "models:CUD",
      });

      // Check if regex is valid POSIX regex
      // Use DB to check, because JS regex is not POSIX compliant

      const isValidRegex = await isValidPostgresRegex(
        input.matchPattern,
        ctx.prisma,
      );
      if (!isValidRegex) {
        throw new TRPCError({
          code: "BAD_REQUEST",
          message: "Invalid regex, needs to be Postgres syntax",
        });
      }

      const createdModel = await ctx.prisma.$transaction(async (tx) => {
        const createdModel = await tx.model.create({
          data: {
            projectId: input.projectId,
            modelName: input.modelName,
            matchPattern: input.matchPattern,
            startDate: input.startDate,
            inputPrice: input.inputPrice,
            outputPrice: input.outputPrice,
            totalPrice: input.totalPrice,
            unit: input.unit,
            tokenizerId: input.tokenizerId,
            tokenizerConfig: input.tokenizerConfig,
          },
        });

        // Populate prices table
        const prices = [
          { usageType: "input", price: input.inputPrice },
          { usageType: "output", price: input.outputPrice },
          { usageType: "total", price: input.totalPrice },
        ];

        for (const { usageType, price } of prices) {
          if (price != null) {
            await tx.price.create({
              data: {
                modelId: createdModel.id,
                usageType,
                price,
              },
            });
          }
        }

        return createdModel;
      });

      await auditLog({
        session: ctx.session,
        resourceType: "model",
        resourceId: createdModel.id,
        action: "create",
        after: createdModel,
      });

      return createdModel;
    }),
});
