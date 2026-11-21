import { createApiHandlers } from "tansy/routes";
import config from "../../../tansy.config";

export const { GET, POST, PUT, PATCH, DELETE, HEAD, OPTIONS } = createApiHandlers(config);
