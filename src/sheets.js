import { google } from 'googleapis';
import fs from 'fs';

const TOKEN_FILE = '.session/google.json';

function getOAuth2Client() {
  if (!fs.existsSync(TOKEN_FILE)) {
    throw new Error('[sheets] No Google token. Run: npm run auth -- --site google');
  }
  const tokens = JSON.parse(fs.readFileSync(TOKEN_FILE, 'utf-8'));
  const oauth2 = new google.auth.OAuth2(
    process.env.GOOGLE_CLIENT_ID,
    process.env.GOOGLE_CLIENT_SECRET,
    'http://localhost:3000/callback',
  );
  oauth2.setCredentials(tokens);
  // Auto-persist refreshed tokens
  oauth2.on('tokens', newTokens => {
    const updated = { ...tokens, ...newTokens };
    fs.writeFileSync(TOKEN_FILE, JSON.stringify(updated, null, 2));
  });
  return oauth2;
}

function today() {
  const d = new Date();
  return [
    String(d.getDate()).padStart(2, '0'),
    String(d.getMonth() + 1).padStart(2, '0'),
    d.getFullYear(),
  ].join('/');
}

function hyperlink(url, text) {
  const safeUrl = (url || '').replace(/"/g, '%22');
  const safeText = (text || '').replace(/"/g, '""');
  return `=HYPERLINK("${safeUrl}";"${safeText}")`;
}

let _sheetTitle = null;

async function getSheetTitle(sheetsApi) {
  if (_sheetTitle) return _sheetTitle;
  const res = await sheetsApi.spreadsheets.get({
    spreadsheetId: process.env.GOOGLE_SPREADSHEET_ID,
  });
  const gid = parseInt(process.env.GOOGLE_SHEET_GID, 10);
  const sheet = res.data.sheets.find(s => s.properties.sheetId === gid);
  if (!sheet) throw new Error(`[sheets] Sheet GID ${gid} not found in spreadsheet`);
  _sheetTitle = sheet.properties.title;
  console.log(`[sheets] Using sheet: "${_sheetTitle}"`);
  return _sheetTitle;
}

/**
 * Append a new application row to the Google Sheet.
 *
 * Columns written (A-P, indices 0-15):
 *   0  Date         DD/MM/YYYY
 *   1  Status       "Applied"
 *   2  Role         empty (fill manually)
 *   3  Stack        =HYPERLINK(jobUrl, jobTitle)
 *   4  Company      =HYPERLINK(linkedinCompanyUrl, companyName)
 *   5  Domain
 *   6  Loc
 *   7-10            empty (Contact, Recruiter, Salary, Rate)
 *   11-14           LinkedIn URLs of referrers (up to 4)
 *   15              empty (Notes)
 *
 * Cell notes "Connection sent" are added to each non-empty referrer cell.
 *
 * @param {{
 *   jobUrl: string,
 *   jobTitle: string,
 *   companyName: string,
 *   linkedinCompanyUrl: string,
 *   domain: string,
 *   loc: string,
 *   referrers: string[]
 * }} data
 * @returns {Promise<number>} row number added
 */
export async function appendApplication({ jobUrl, jobTitle, jobRole, companyName, linkedinCompanyUrl, domain, loc, referrers = [] }) {
  const auth = getOAuth2Client();
  const sheets = google.sheets({ version: 'v4', auth });
  const sheetTitle = await getSheetTitle(sheets);

  const row = new Array(16).fill('');
  row[0] = today();
  row[1] = 'Applied';
  row[2] = jobRole || '';
  row[3] = hyperlink(jobUrl, jobTitle);
  row[4] = hyperlink(linkedinCompanyUrl, companyName);
  row[5] = domain || '';
  row[6] = loc || '';
  for (let i = 0; i < 4; i++) {
    row[11 + i] = referrers[i] || '';
  }

  // Append row
  const appendRes = await sheets.spreadsheets.values.append({
    spreadsheetId: process.env.GOOGLE_SPREADSHEET_ID,
    range: `${sheetTitle}!A:P`,
    valueInputOption: 'USER_ENTERED',
    insertDataOption: 'INSERT_ROWS',
    requestBody: { values: [row] },
  });

  // Parse row number from updatedRange e.g. "Sheet1!A42:P42"
  const updatedRange = appendRes.data.updates?.updatedRange || '';
  const rowNum = parseInt(updatedRange.match(/(\d+)$/)?.[1] || '0', 10);
  console.log(`[sheets] ✓ Row ${rowNum} added: ${companyName}`);

  // Add "Connection sent" cell notes to filled referrer cells
  const filledRefs = referrers.slice(0, 4).filter(Boolean);
  if (rowNum && filledRefs.length) {
    const gid = parseInt(process.env.GOOGLE_SHEET_GID, 10);
    const requests = filledRefs.map((_, i) => ({
      updateCells: {
        range: {
          sheetId: gid,
          startRowIndex: rowNum - 1,
          endRowIndex: rowNum,
          startColumnIndex: 11 + i,
          endColumnIndex: 12 + i,
        },
        rows: [{ values: [{ note: 'Connection sent' }] }],
        fields: 'note',
      },
    }));
    await sheets.spreadsheets.batchUpdate({
      spreadsheetId: process.env.GOOGLE_SPREADSHEET_ID,
      requestBody: { requests },
    });
    console.log(`[sheets] Added "Connection sent" notes to ${filledRefs.length} cell(s)`);
  }

  return rowNum;
}
