import postgres from "postgres";

export function createPostgresClient(connectionString: string) {
  return postgres(connectionString, {
    max: 1,
    prepare: false,
    onnotice: () => undefined,
    transform: {
      undefined: null,
    },
  });
}
