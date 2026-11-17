'use strict';

var teams_apps = require('@microsoft/teams.apps');
var contactRequest_js = require('./contact-request.js');

const app = new teams_apps.App({
  dangerouslyAllowUnauthenticatedRequests: process.env.NODE_ENV === "development" && process.env.TEAMS_ALLOW_UNAUTHENTICATED === "true"
});
const channelConversationId = process.env.PDS_CHANNEL_CONVERSATION_ID || "";
const allowedTenantId = process.env.TENANT_ID || "";
app.on("message", async ({ send, activity }) => {
  if (activity.conversation.conversationType !== "personal") {
    await send("Please send Contact Admin reports in a private chat with PDS Operations.");
    return;
  }
  const activityTenantId = activity.conversation.tenantId || activity.channelData?.tenant?.id || "";
  if (allowedTenantId && activityTenantId !== allowedTenantId) {
    await send("This PDS Operations bot is only available to Planet Drugstore employees.");
    return;
  }
  const request = contactRequest_js.parseContactRequest(activity.text || "");
  if (!request) {
    await send('I could not read the contact form. Please reopen Contact Admin from the notification and add your concern after "Concern:".');
    return;
  }
  if (!channelConversationId) {
    await send("PDS Operations is not connected to its Teams channel yet. Please contact IT.");
    return;
  }
  try {
    await app.send(channelConversationId, {
      type: "message",
      text: contactRequest_js.formatChannelPost(request, activity.from.name || "PDS employee")
    });
    await send("Your concern was sent to PDS Operations.");
  } catch (error) {
    console.error("Could not post a PDS Operations contact request:", error);
    await send("I could not send your concern to PDS Operations. Please try again or contact your admin.");
  }
});
app.start(process.env.PORT || 3978).catch(console.error);
//# sourceMappingURL=index.js.map
//# sourceMappingURL=index.js.map