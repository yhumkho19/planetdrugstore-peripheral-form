export interface ContactRequest {
  name: string;
  role: string;
  eventSite: string;
  date: string;
  concern: string;
}

const fieldNames = new Map<string, keyof ContactRequest>([
  ['name', 'name'],
  ['role', 'role'],
  ['event site', 'eventSite'],
  ['date', 'date'],
  ['concern', 'concern'],
]);

export function parseContactRequest(message: string): ContactRequest | null {
  const fields: Partial<ContactRequest> = {};
  let currentField: keyof ContactRequest | null = null;

  for (const line of String(message || '').split(/\r?\n/)) {
    const separator = line.indexOf(':');
    const label = separator >= 0 ? line.slice(0, separator).trim().toLowerCase() : '';
    const field = fieldNames.get(label);
    if (field && separator >= 0) {
      currentField = field;
      fields[field] = line.slice(separator + 1).trim();
    } else if (currentField === 'concern') {
      fields.concern = `${fields.concern || ''}\n${line}`.trim();
    }
  }

  if (!fields.name || !fields.role || !fields.eventSite || !fields.date || !fields.concern) return null;
  return {
    name: fields.name,
    role: fields.role,
    eventSite: fields.eventSite,
    date: fields.date,
    concern: fields.concern,
  };
}

export function formatChannelPost(request: ContactRequest, submittedBy: string): string {
  return [
    'PDS Operations contact request',
    '',
    `Name: ${request.name}`,
    `Role: ${request.role}`,
    `Event Site: ${request.eventSite}`,
    `Date: ${request.date}`,
    '',
    `Concern: ${request.concern}`,
    `Submitted by: ${submittedBy}`,
  ].join('\n');
}

export function formatPrefilledMessage(request: Omit<ContactRequest, 'concern'>): string {
  return [
    `Name: ${request.name}`,
    `Role: ${request.role}`,
    `Event Site: ${request.eventSite}`,
    `Date: ${request.date}`,
    '',
    'Concern: ',
  ].join('\n');
}