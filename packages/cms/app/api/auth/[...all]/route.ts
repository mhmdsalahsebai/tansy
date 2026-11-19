import { authEndpoint } from "../../../../core/authz/guard";

export const GET = authEndpoint();
export const POST = authEndpoint();
