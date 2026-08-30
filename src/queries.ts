export const listCreativeToniesQuery = `
  {
    households {
      access
      canLeave
      foreignCreativeTonieContent
      id
      image
      name
      ownerName
      creativeTonies {
        id
        name
        live
        private
        imageUrl
        secondsRemaining
        secondsPresent
        chaptersPresent
        tune {
          item {
            title
            languageUnicode
          }
        }
      }
    }
  }
`;

export const creativeTonieDetailQuery = `
  query ($householdId: String, $creativeTonieId: String) {
    me {
      email
    }
    config {
      maxChapters
      maxSeconds
      maxBytes
      accepts
    }
    households(id: $householdId) {
      id
      access
      image
      name
      ownerName
      creativeTonies(id: $creativeTonieId) {
        id
        name
        live
        private
        imageUrl
        transcoding
        secondsRemaining
        secondsPresent
        chaptersPresent
        chaptersRemaining
        chapters {
          id
          title
          file
          thumbnail
          seconds
          transcoding
          type
        }
        permissions {
          membershipId
          displayName
          profileImage
          permission
        }
        associatedContentTokens {
          id
          token
          title
          subtitle
          description
          thumbnail
          languageUnicode
          minAge
          chapters {
            title
            seconds
          }
          authors {
            name
          }
        }
        tune {
          id
          item {
            id
            title
            authors {
              name
            }
            description
            contentInfo {
              chapters {
                title
                seconds
              }
              seconds
            }
            minAge
            languageName
            languageUnicode
            thumbnail
          }
        }
      }
    }
  }
`;

export const creativeTonieRefreshQuery = `
  query ($householdId: String, $creativeTonieId: String) {
    households(id: $householdId) {
      creativeTonies(id: $creativeTonieId) {
        transcoding
        transcodingErrors {
          message
          reason
        }
        secondsRemaining
        tune {
          id
          item {
            id
            title
            languageName
            languageUnicode
            thumbnail
          }
        }
        chapters {
          id
          title
          thumbnail
          file
          seconds
          transcoding
        }
      }
    }
  }
`;

export const contentTonieDetailQuery = `
  query ContentTonieDetail($householdId: String, $contentTonieId: String) {
    households(id: $householdId) {
      id
      contentTonies(id: $contentTonieId) {
        id
        title
        description
        imageUrl
        coverUrl
        supportedLanguages
        languageUnicode
        secondsPresent
        chapters {
          name
        }
        tune {
          id
          item {
            id
            title
            thumbnail
            contentInfo {
              seconds
              chapters {
                title
                seconds
              }
            }
            description
          }
        }
      }
    }
  }
`;

export const tonieboxesQuery = `
  {
    households {
      access
      id
      name
      tonieboxes {
        id
        name
        imageUrl
        householdId
      }
    }
  }
`;
