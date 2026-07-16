require('dotenv').config();

const fs = require('fs');
const path = require('path');
const express = require('express');
const fetch = require('node-fetch');

const app = express();
const PORT = process.env.PORT || 3000;

// ---------------------------------------------------------------------------
// Value mappings — SAP returns numeric codes for extensions.Z_media and
// extensions.Z_project. These must never reach the browser as raw codes, so
// they are translated to their descriptions here, server-side.
// ---------------------------------------------------------------------------
const UNMAPPED_LABEL = 'לא ממופה'; // "Not mapped" — shown instead of a raw code

function loadMapping(fileName) {
  const filePath = path.join(__dirname, 'data', fileName);
  try {
    const raw = fs.readFileSync(filePath, 'utf-8');
    return JSON.parse(raw);
  } catch (err) {
    console.error(`Failed to load mapping file ${fileName}:`, err.message);
    return {};
  }
}

const MEDIA_MAPPING = loadMapping('media-mapping.json');
const PROJECT_MAPPING = loadMapping('project-mapping.json');

function mapCode(mapping, rawValue) {
  if (rawValue === null || rawValue === undefined || String(rawValue).trim() === '') {
    return 'לא צוין'; // "Unspecified"
  }
  const key = String(rawValue).trim();
  const label = mapping[key];
  if (!label) {
    console.warn(`No mapping found for code "${key}" — showing "${UNMAPPED_LABEL}" instead.`);
    return UNMAPPED_LABEL;
  }
  return label;
}

/**
 * extensions.Z_media is an array of codes (an Opportunity can carry more
 * than one media). Each code is mapped individually — never joined into a
 * single string and looked up as one key (e.g. "43,77" is not a valid key
 * even though "43" and "77" are).
 */
function mapCodeArray(mapping, rawValue) {
  const values = Array.isArray(rawValue) ? rawValue : rawValue === null || rawValue === undefined ? [] : [rawValue];
  const cleaned = values.map((v) => String(v).trim()).filter((v) => v !== '');

  if (cleaned.length === 0) {
    return ['לא צוין']; // "Unspecified"
  }

  return cleaned.map((key) => {
    const label = mapping[key];
    if (!label) {
      console.warn(`No mapping found for code "${key}" — showing "${UNMAPPED_LABEL}" instead.`);
      return UNMAPPED_LABEL;
    }
    return label;
  });
}

/**
 * Returns a copy of the opportunity where extensions.Z_media and
 * extensions.Z_project have been replaced with their human-readable
 * descriptions. The original numeric codes are dropped entirely so they
 * can never be displayed to the user. Z_media is an array (an Opportunity
 * can have multiple media), so it becomes an array of descriptions;
 * Z_project is a single code, so it becomes a single description.
 */
function applyValueMappings(opp) {
  const ext = (opp && opp.extensions) || {};
  return {
    ...opp,
    extensions: {
      ...ext,
      Z_media: mapCodeArray(MEDIA_MAPPING, ext.Z_media),
      Z_project: mapCode(PROJECT_MAPPING, ext.Z_project),
    },
  };
}

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------
const SAP_BASE_URL =
  process.env.SAP_BASE_URL ||
  'https://my1002519.de1.crm.cloud.sap/sap/c4c/api/v1/opportunity-service/opportunities';

const SAP_USERNAME = process.env.SAP_USERNAME;
const SAP_PASSWORD = process.env.SAP_PASSWORD;

const USE_MOCK_DATA = String(process.env.USE_MOCK_DATA || '').toLowerCase() === 'true';

const MAX_PAGES = 100; // safety guard against runaway pagination
const PAGE_SIZE = 200;

app.use(express.static('public'));
app.use(express.json());

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Returns 'YYYY-MM-DD' for the start date matching the requested period. */
function computeStartDate(period) {
  const now = new Date();
  const y = now.getFullYear();
  const m = now.getMonth(); // 0-indexed
  const d = now.getDate();

  let start;
  if (period === 'day') {
    start = new Date(y, m, d);
  } else if (period === 'month') {
    start = new Date(y, m, 1);
  } else if (period === 'year') {
    start = new Date(y, 0, 1);
  } else {
    throw new Error(`Invalid period: ${period}`);
  }

  const pad = (n) => String(n).padStart(2, '0');
  return `${start.getFullYear()}-${pad(start.getMonth() + 1)}-${pad(start.getDate())}`;
}

function buildAuthHeader() {
  if (!SAP_USERNAME || !SAP_PASSWORD) {
    throw new Error(
      'Missing SAP_USERNAME / SAP_PASSWORD environment variables. Set them before starting the server.'
    );
  }
  const token = Buffer.from(`${SAP_USERNAME}:${SAP_PASSWORD}`).toString('base64');
  return `Basic ${token}`;
}

/**
 * Pulls every page of Opportunities for the given start date filter,
 * following either OData v4 (@odata.nextLink / value) or OData v2
 * (d.results / d.__next) style pagination, whichever the tenant returns.
 */
async function fetchAllOpportunities(startDate) {
  const authHeader = buildAuthHeader();
  const results = [];

  let url =
    `${SAP_BASE_URL}?$filter=${encodeURIComponent(`startDate gt '${startDate}'`)}` +
    `&$top=${PAGE_SIZE}`;

  for (let page = 0; page < MAX_PAGES && url; page++) {
    const response = await fetch(url, {
      method: 'GET',
      headers: {
        Authorization: authHeader,
        Accept: 'application/json',
      },
    });

    if (!response.ok) {
      const bodyText = await response.text().catch(() => '');
      const err = new Error(
        `SAP API request failed with status ${response.status} ${response.statusText}`
      );
      err.status = response.status;
      err.body = bodyText;
      throw err;
    }

    const json = await response.json();

    // OData v4 / REST style
    if (Array.isArray(json.value)) {
      results.push(...json.value);
      url = json['@odata.nextLink'] || null;
      continue;
    }

    // OData v2 style
    if (json.d && Array.isArray(json.d.results)) {
      results.push(...json.d.results);
      url = json.d.__next || null;
      continue;
    }

    // Plain array fallback
    if (Array.isArray(json)) {
      results.push(...json);
      url = null;
      continue;
    }

    // Unknown shape - stop, return what we parsed (none)
    url = null;
  }

  return results;
}

function generateMockOpportunities(startDate) {
  const start = new Date(startDate);
  const end = new Date();
  const mediaCodes = Object.keys(MEDIA_MAPPING);
  const projectCodes = Object.keys(PROJECT_MAPPING);
  const media = mediaCodes.length ? mediaCodes : ['1', '44', '71'];
  const projects = projectCodes.length ? projectCodes : ['1000005125'];
  const out = [];
  let id = 1;

  for (let t = start.getTime(); t <= end.getTime(); t += 24 * 60 * 60 * 1000) {
    const day = new Date(t);
    const count = Math.floor(Math.random() * 6); // 0-5 opportunities that day
    for (let i = 0; i < count; i++) {
      out.push({
        ObjectID: `MOCK-${id++}`,
        startDate: day.toISOString().slice(0, 10),
        extensions: {
          // SAP returns Z_media as an array — an Opportunity can carry more than one
          Z_media: Math.random() < 0.35
            ? [media[Math.floor(Math.random() * media.length)], media[Math.floor(Math.random() * media.length)]]
            : [media[Math.floor(Math.random() * media.length)]],
          Z_project: projects[Math.floor(Math.random() * projects.length)],
        },
      });
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// Routes
// ---------------------------------------------------------------------------

app.get('/api/opportunities', async (req, res) => {
  const period = req.query.period;

  if (!['day', 'month', 'year'].includes(period)) {
    return res.status(400).json({
      error: "Invalid or missing 'period' query parameter. Use 'day', 'month', or 'year'.",
    });
  }

  try {
    const startDate = computeStartDate(period);

    const rawOpportunities = USE_MOCK_DATA
      ? generateMockOpportunities(startDate)
      : await fetchAllOpportunities(startDate);

    // Never forward raw numeric codes to the browser — translate them here.
    const opportunities = rawOpportunities.map(applyValueMappings);

    res.json({
      period,
      startDate,
      filter: `startDate gt '${startDate}'`,
      count: opportunities.length,
      opportunities,
      mock: USE_MOCK_DATA,
    });
  } catch (err) {
    console.error('Failed to fetch opportunities:', err);
    res.status(err.status || 500).json({
      error: err.message || 'Unexpected error while fetching Opportunities.',
      details: err.body,
    });
  }
});

app.get('/api/health', (req, res) => {
  res.json({
    status: 'ok',
    hasCredentials: Boolean(SAP_USERNAME && SAP_PASSWORD),
    mock: USE_MOCK_DATA,
    mediaMappingEntries: Object.keys(MEDIA_MAPPING).length,
    projectMappingEntries: Object.keys(PROJECT_MAPPING).length,
  });
});

app.listen(PORT, () => {
  console.log(`Opportunities dashboard server listening on port ${PORT}`);
  if (USE_MOCK_DATA) {
    console.log('USE_MOCK_DATA=true -> serving generated sample data instead of calling SAP.');
  } else if (!SAP_USERNAME || !SAP_PASSWORD) {
    console.warn(
      'WARNING: SAP_USERNAME / SAP_PASSWORD are not set. API requests will fail until they are configured.'
    );
  }
});
