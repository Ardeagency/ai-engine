import express from "express";
import { taskEventController } from "../controllers/task-event.controller.js";

const router = express.Router();

router.post("/", taskEventController);

export default router;

