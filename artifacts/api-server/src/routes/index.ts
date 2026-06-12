import { Router, type IRouter } from "express";
import healthRouter from "./health";
import commentaryRouter from "./commentary";

const router: IRouter = Router();

router.use(healthRouter);
router.use(commentaryRouter);

export default router;
