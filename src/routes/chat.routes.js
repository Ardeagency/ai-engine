import express from "express";
import { chatController, conversationStatus } from "../controllers/chat.controller.js";

const router = express.Router();

router.post("/", chatController);

// Polling endpoint — para frontends sin Supabase Realtime
// GET /chat/conversation/:id/status?organization_id=<uuid>
router.get("/conversation/:id/status", conversationStatus);

export default router;