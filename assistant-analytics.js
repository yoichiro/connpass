const { Logging } = require('@google-cloud/logging');

const logging = new Logging({
  projectId: process.env.GCLOUD_PROJECT
});
const log = logging.log('assistant-analytics');

const LogMetadata = {
  resource: {
    type: 'global',
    labels: {
      function_name: process.env.FUNCTION_NAME,
      project: process.env.GCLOUD_PROJECT,
      region: process.env.FUNCTION_REGION
    }
  }
};

class AssistantAnalytics {
  trace(conv) {
    const data = {
      timestamp: Date.now(),
      conversation_id: conv.id,
      request: {
        available_surfaces: conv.request.availableSurfaces[0].capabilities.map(capability => capability.name),
        surfaces: conv.request.surface ? conv.request.surface.capabilities.map(capability => capability.name): undefined,
        is_in_sandbox: conv.request.isInSandbox,
        intent_name: conv.intent || conv.request.inputs[0].intent,
        raw_input: conv.request.inputs[0].rawInputs[0],
        arguments: JSON.stringify(conv.request.inputs[0].arguments),
        location: conv.request.device ? conv.request.device.location : undefined,
        user: conv.request.user
      },
      expect_user_response: conv.expectUserResponse,
      sandbox: conv.sandbox,
      conversation_type: conv.type,
      responses: JSON.stringify(conv.responses),
      no_inputs: JSON.stringify(conv.noInputs),
      speech_biasing: conv.speechBiasing
    };
    const entry = log.entry(LogMetadata, data);
    log.info(entry);
  }
}

module.exports = new AssistantAnalytics();
