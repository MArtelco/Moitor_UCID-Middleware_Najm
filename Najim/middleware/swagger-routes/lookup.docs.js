/**
 * @openapi
 * tags:
 *   - name: Lookup
 *     description: Utility endpoints for retrieving UCID
 */

/**
 * @openapi
 * /api/lookup/ucidByTicket:
 *   get:
 *     tags: [Lookup]
 *     summary: Get UCID by exact ticket number
 *     description: Returns UCID, ticket_number, and agent_user for the provided ticket.
 *     parameters:
 *       - in: query
 *         name: ticket
 *         required: true
 *         schema: { type: string }
 *         description: Exact ticket number to match.
 *     responses:
 *       200: { description: Returns UCID(s) with ticket_number and agent_user }
 *       400: { description: Missing required query parameter (ticket) }
 *       500: { description: Database connection or query error }
 */
