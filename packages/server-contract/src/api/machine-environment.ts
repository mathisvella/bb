import { z } from "zod";

export const machineEnvironmentNameSchema = z
  .string()
  .regex(/^[A-Za-z_][A-Za-z0-9_]*$/u)
  .max(128);
export const machineEnvironmentBrokerPolicySchema = z.enum([
  "stripe",
  "cloudflare",
  "sentry",
  "postmark",
  "supabase-management",
  "supabase-project",
]);
export const machineEnvironmentBrokerHostSchema = z
  .string()
  .regex(
    /^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)+$/u,
  )
  .max(253);
export type MachineEnvironmentBrokerPolicy = z.infer<
  typeof machineEnvironmentBrokerPolicySchema
>;
export const machineEnvironmentSetSchema = z
  .object({
    name: machineEnvironmentNameSchema,
    value: z
      .string()
      .max(65536)
      .refine(
        (value) => !value.includes("\0"),
        "Environment values cannot contain NUL",
      ),
    note: z.string().max(1024).nullable().default(null),
    brokerPolicy: machineEnvironmentBrokerPolicySchema.nullable().default(null),
    brokerAllowWrite: z.boolean().default(false),
    brokerHost: machineEnvironmentBrokerHostSchema.nullable().default(null),
  })
  .strict();
export type MachineEnvironmentSet = z.input<typeof machineEnvironmentSetSchema>;
export const machineEnvironmentVariableSchema = z
  .object({
    name: machineEnvironmentNameSchema,
    value: z.null(),
    secret: z.literal(true),
    note: z.string().nullable(),
    brokerPolicy: machineEnvironmentBrokerPolicySchema.nullable().optional(),
    brokerAllowWrite: z.boolean().optional(),
    brokerHost: machineEnvironmentBrokerHostSchema.nullable().optional(),
  })
  .strict();
export type MachineEnvironmentVariable = z.infer<
  typeof machineEnvironmentVariableSchema
>;
export const machineEnvironmentListSchema = z.object({
  builtInGit: z.object({
    status: z.enum(["logged in", "not logged in", "overridden", "disabled"]),
    statusMessage: z.string(),
  }),
  variables: z.array(machineEnvironmentVariableSchema),
});
export type MachineEnvironmentList = z.infer<
  typeof machineEnvironmentListSchema
>;

export const machineEnvironmentDeleteSchema = machineEnvironmentSetSchema.pick({
  name: true,
});
export type MachineEnvironmentDelete = z.infer<
  typeof machineEnvironmentDeleteSchema
>;
export const projectMachineEnvironmentListSchema =
  machineEnvironmentListSchema.extend({
    inheritedVariables: z.array(machineEnvironmentVariableSchema),
  });
export type ProjectMachineEnvironmentList = z.infer<
  typeof projectMachineEnvironmentListSchema
>;

export const machineEnvironmentBrokerCallSchema = z
  .object({
    capabilityToken: z.string().min(32).max(256),
    name: machineEnvironmentNameSchema,
    method: z.enum(["GET", "POST", "PUT", "PATCH", "DELETE"]),
    url: z.string().url().max(4096),
    headers: z.record(z.string().max(256), z.string().max(8192)).default({}),
    body: z.string().max(1_048_576).nullable().default(null),
  })
  .strict();
export type MachineEnvironmentBrokerCall = z.infer<
  typeof machineEnvironmentBrokerCallSchema
>;

export const machineEnvironmentBrokerResponseSchema = z.object({
  status: z.number().int().min(100).max(599),
  headers: z.record(z.string(), z.string()),
  body: z.string(),
  bodyEncoding: z.enum(["utf8", "base64"]),
});
export type MachineEnvironmentBrokerResponse = z.infer<
  typeof machineEnvironmentBrokerResponseSchema
>;
