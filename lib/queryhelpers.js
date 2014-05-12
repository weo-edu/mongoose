/*!
 * If the document is a mapped discriminator type, it returns a model instance for that type, otherwise,
 * it returns an instance of the given model.
 *
 * @param {Model}  model
 * @param {Object} doc
 *
 * @return {Model}
 */
exports.createModel = function createModel(model, doc) {
  var discriminatorMapping = model.schema
    ? model.schema.discriminatorMapping
    : null;

  var key = discriminatorMapping && discriminatorMapping.isRoot
    ? discriminatorMapping.key
    : null;

  if (key && doc[key] && model.discriminators && model.discriminators[doc[key]]) {
    return new model.discriminators[doc[key]](undefined, undefined, true);
  }

  return new model(undefined, undefined, true);
}
