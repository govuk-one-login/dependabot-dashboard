import { Router } from "express";
import preflightRouter from "./dependabot/preflight.js";
import prActionsRouter from "./dependabot/pr-actions.js";
import fixKiroRouter from "./dependabot/fix-kiro.js";
import fixOllamaRouter from "./dependabot/fix-ollama.js";
import fixRegistryRouter from "./dependabot/fix-registry.js";

const router = Router();
router.use(preflightRouter);
router.use(prActionsRouter);
router.use(fixKiroRouter);
router.use(fixOllamaRouter);
router.use(fixRegistryRouter);
export default router;
