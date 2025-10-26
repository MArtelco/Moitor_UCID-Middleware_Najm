/**
 * @openapi
 * tags:
 *   - name: ACR
 *     description: Avaya Call Recorder search & playback
 */

/**
 * @openapi
 * /api/acr/searchByNumber:
 *   get:
 *     tags: [ACR]
 *     summary: Search ACR by calling number (party name)
 *     description: If "limit" is omitted or 0, only the first (latest) result is returned. If "limit" > 0, up to that many results are returned (newest first).
 *     parameters:
 *       - in: query
 *         name: number
 *         required: true
 *         schema: { type: string }
 *       - in: query
 *         name: startdate
 *         required: true
 *         schema: { type: string, format: date }
 *       - in: query
 *         name: enddate
 *         schema: { type: string, format: date }
 *       - in: query
 *         name: starttime
 *         schema: { type: string }
 *       - in: query
 *         name: endtime
 *         schema: { type: string }
 *       - in: query
 *         name: limit
 *         description: Optional. Maximum number of results to return. If omitted or 0, only the first result is returned.
 *         schema: { type: integer, minimum: 0 }
 *     responses:
 *       200:
 *         description: Search results (single item or list) with INUM metadata
 */


/**
 * @openapi
 * /api/acr/replayByUcid:
 *   get:
 *     tags: [ACR]
 *     summary: Search by UCID then replay (local WAV default)
 *     parameters:
 *       - in: query
 *         name: ucid
 *         required: true
 *         schema: { type: string }
 *       - in: query
 *         name: startdate
 *         required: true
 *         schema: { type: string, format: date }
 *       - in: query
 *         name: redirect
 *         schema: { type: boolean }
 *       - in: query
 *         name: local
 *         schema: { type: boolean }
 *     responses:
 *       200: { description: Audio stream (wav/proxy) }
 */
