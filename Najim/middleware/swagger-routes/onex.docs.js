/**
 * @openapi
 * tags:
 *   - name: OneX
 *     description: Avaya one-X Agent control 
 */

/**
 * @openapi
 * /api/onex/startcall:
 *   get:
 *     tags: [OneX]
 *     summary: Place an outbound call via One-X Agent; polls for UCID & Interaction
 *     parameters:
 *       - in: query
 *         name: ticketNumber
 *         required: true
 *         schema: { type: string }
 *       - in: query
 *         name: clientPhone
 *         required: true
 *         schema: { type: string }
 *       - in: query
 *         name: deviceIp
 *         required: true
 *         schema: { type: string }
 *       - in: query
 *         name: station
 *         required: true
 *         schema: { type: string }
 *       - in: query
 *         name: agentUser
 *         required: false
 *         schema: { type: string }
 *         
 *     responses:
 *       200: { description: Result includes Call Info, interaction id, and dialed number }
 *       400: { description: Missing params }
 *       500: { description: One-X error or registration failure }
 */

/**
 * @openapi
 * /api/onex/release:
 *   get:
 *     tags: [OneX]
 *     summary: End a call (release a voice interaction)
 *     description: Calls One-X `/voice/release` for the given interaction.
 *     parameters:
 *       - in: query
 *         name: deviceIp
 *         required: true
 *         schema: { type: string }
 *         description: IP for the One-X Agent device.
 *       - in: query
 *         name: interactionid
 *         required: true
 *         schema: { type: string }
 *         description: Voice interaction ObjectId (e.g., VI24:GUID) from VoiceInteractionCreated.
 *       - in: query
 *         name: agentUser
 *         required: false
 *         schema: { type: string }
 *         description: Optional, only used for logging.
 *     responses:
 *       200: { description: One-X response (ResponseCode 0=Success, others=Error) }
 *       400: { description: Missing params }
 *       500: { description: Error invoking One-X API }
 */

/**
 * @openapi
 * /api/onex/hold:
 *   get:
 *     tags: [OneX]
 *     summary: Hold an active voice interaction
 *     parameters:
 *       - in: query
 *         name: deviceIp
 *         required: true
 *         schema: { type: string }
 *       - in: query
 *         name: interactionid
 *         required: true
 *         schema: { type: string }
 *       - in: query
 *         name: agentUser
 *         required: false
 *         schema: { type: string }
 *         description: Optional, only used for logging.
 *     responses:
 *       200: { description: One-X response (ResponseCode 0=Success, others=Error) }
 *       400: { description: Missing params }
 *       500: { description: Error invoking One-X API }
 */

/**
 * @openapi
 * /api/onex/unhold:
 *   get:
 *     tags: [OneX]
 *     summary: Unhold a voice interaction
 *     parameters:
 *       - in: query
 *         name: deviceIp
 *         required: true
 *         schema: { type: string }
 *       - in: query
 *         name: interactionid
 *         required: true
 *         schema: { type: string }
 *       - in: query
 *         name: agentUser
 *         required: false
 *         schema: { type: string }
 *     responses:
 *       200: { description: One-X response (ResponseCode 0=Success, others=Error) }
 *       400: { description: Missing params }
 *       500: { description: Error invoking One-X API }
 */

/**
 * @openapi
 * /api/onex/mute:
 *   get:
 *     tags: [OneX]
 *     summary: Mute the phone
 *     parameters:
 *       - in: query
 *         name: deviceIp
 *         required: true
 *         schema: { type: string }
 *       - in: query
 *         name: interactionid
 *         required: false
 *         schema: { type: string }
 *         description: Optional; stored in DB for easier lookup. One-X /voice/mute does not require it.
 *       - in: query
 *         name: agentUser
 *         required: false
 *         schema: { type: string }
 *     responses:
 *       200: { description: One-X response (ResponseCode 0=Success, others=Error) }
 *       400: { description: Missing params }
 *       500: { description: Error invoking One-X API }
 */

/**
 * @openapi
 * /api/onex/unmute:
 *   get:
 *     tags: [OneX]
 *     summary: Unmute the phone
 *     parameters:
 *       - in: query
 *         name: deviceIp
 *         required: true
 *         schema: { type: string }
 *       - in: query
 *         name: interactionid
 *         required: false
 *         schema: { type: string }
 *         description: Optional; stored in DB for easier lookup. One-X /voice/unmute does not require it.
 *       - in: query
 *         name: agentUser
 *         required: false
 *         schema: { type: string }
 *     responses:
 *       200: { description: One-X response (ResponseCode 0=Success, others=Error) }
 *       400: { description: Missing params }
 *       500: { description: Error invoking One-X API }
 */
