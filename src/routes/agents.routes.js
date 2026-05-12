import express from "express";
import {
  getStatus,
  provision,
  stop,
  fleet,
  policy,
} from "../controllers/agents.controller.js";

const router = express.Router();

router.get("/status",    getStatus);
router.post("/provision", provision);
router.post("/stop",     stop);
router.get("/fleet",     fleet);
router.get("/policy",    policy);

export default router;
