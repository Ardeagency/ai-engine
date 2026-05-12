import express from "express";
import {
  createMissionEndpoint,
  listMissions,
} from "../controllers/agents.controller.js";

const router = express.Router();

router.post("/",  createMissionEndpoint);
router.get("/",   listMissions);

export default router;
