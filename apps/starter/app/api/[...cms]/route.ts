import config from "@/tansy.config";
import { createApiHandlers } from "tansy/routes";

export const { GET, POST, PUT, PATCH, DELETE, HEAD, OPTIONS } = createApiHandlers(config);
