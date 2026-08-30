export const apiMap = {
  specification: "https://api.tonie.cloud/v2/doc/?format=openapi",
  discovery: "api operations lists the complete live REST surface; raw operation invokes any operationId",
  realtime: {
    broker: "wss://ici.tonie.cloud/",
    protocol: "MQTT 5, account UUID username, access-token password",
    state: "external/toniebox/{MAC}/{online-state,playback/state,volume/state,metrics/battery,metrics/headphones,app-reply/bedtime-state}",
    control: "external/toniebox/{MAC}/app-control/{playback,volume,stl,sleep}",
    limitations: "Feature-gated; online boxes only; no cloud wake; broker acknowledgement is not device confirmation"
  },
  auth: [
    {
      method: "POST",
      url: "https://login.tonies.com/auth/realms/tonies/protocol/openid-connect/token",
      purpose: "Refresh access token with refresh_token and client_id=my-tonies"
    }
  ],
  graphql: [
    {
      method: "POST",
      path: "/graphql",
      purpose: "List households, Creative-Tonies, Content-Tonies, Tonieboxes, members, tunes, content tokens"
    }
  ],
  creativeTonies: [
    {
      method: "PATCH",
      path: "/households/{householdId}/creativetonies/{creativeTonieId}",
      purpose: "Rename, toggle live/private, replace playlist chapters"
    },
    {
      method: "DELETE",
      path: "/households/{householdId}/creativetonies/{creativeTonieId}",
      purpose: "Remove Creative-Tonie from household"
    },
    {
      method: "PUT",
      path: "/households/{householdId}/creativetonies/{creativeTonieId}/permissions/{membershipId}",
      purpose: "Set Creative-Tonie member permission"
    },
    {
      method: "DELETE",
      path: "/households/{householdId}/tonie/{creativeTonieId}/tune",
      purpose: "Remove assigned paid tune and restore own playlist mode"
    },
    {
      method: "PUT",
      path: "/households/{householdId}/tonie/{creativeTonieId}/tune/{myTuneId}",
      purpose: "Assign paid tune to Creative-Tonie"
    }
  ],
  uploads: [
    {
      method: "POST",
      path: "/file",
      purpose: "Create fileId plus S3 form upload request for custom audio"
    },
    {
      method: "POST",
      url: "{request.url}",
      purpose: "Submit returned S3 multipart form fields plus file blob"
    }
  ],
  contentTonies: [
    {
      method: "PATCH",
      path: "/households/{householdId}/contenttonies/{contentTonieId}",
      purpose: "Toggle content Tonie lock"
    },
    {
      method: "DELETE",
      path: "/households/{householdId}/contenttonies/{contentTonieId}",
      purpose: "Remove content Tonie from household"
    }
  ],
  households: [
    {
      method: "GET",
      path: "/me",
      purpose: "Current account"
    },
    {
      method: "POST",
      path: "/households",
      purpose: "Create household"
    },
    {
      method: "POST",
      path: "/households/{householdId}/tonieboxes",
      purpose: "Add Toniebox"
    },
    {
      method: "PUT",
      path: "/households/{householdId}/memberships/{membershipId}",
      purpose: "Change member access"
    }
  ],
  tonieboxes: [
    {
      method: "GET",
      path: "/households/{householdId}/tonieboxes/{tonieboxId}",
      purpose: "Inspect settings, generation, product, MAC, and supported features"
    },
    {
      method: "PATCH",
      path: "/households/{householdId}/tonieboxes/{tonieboxId}",
      purpose: "Change volume limits, light ring, bedtime light/volume settings, language, skipping, and age mode"
    },
    {
      method: "DELETE",
      path: "/households/{householdId}/tonieboxes/{tonieboxId}",
      purpose: "Reset and remove a Toniebox from the household"
    },
    {
      method: "GRAPHQL",
      path: "households { tonieboxes { id name imageUrl householdId } }",
      purpose: "List Tonieboxes"
    }
  ]
} as const;
