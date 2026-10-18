import { defineRailway, project, service } from "railway/iac";

// Per-service partial CaC: manages ONLY the gracious-peace service subtree so
// this repo can never mutate unrelated projects under the account.
// Replaces railway.json (deprecated by Railway until 2026-12-01).
export const partial = "gracious-peace";

export default defineRailway(() => {
  const web = service("gracious-peace", {
    healthcheck: "/healthz",
    healthcheckTimeout: 60,
    builder: "DOCKERFILE",
    dockerfilePath: "Dockerfile",
  });

  return project("owoworks", {
    resources: [web],
  });
});
