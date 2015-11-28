
var crypto = require('crypto');

var AWS = require('aws-sdk');
var CfnLambda = require('cfn-lambda');

var APIG = new AWS.APIGateway({apiVersion: '2015-07-09'});

exports.handler = CfnLambda({
  Create: Create,
  Update: Update,
  Delete: Delete,
  NoUpdate: NoUpdate,
  SchemaPath: [__dirname, 'schema.json']
});

function Upsert(cleanable, makeable, reply) {
  var idHash = {};
  console.log('Sanitizing old tree: %j', cleanable);
  cleanParent(cleanable.RestApiId, cleanable.ParentId,
    function(cleanErr, cleanedPath) {
      if (cleanErr) {
        console.log('Failed to clean ParentId %s, FAILURE: %j',
          cleanable.ParentId, cleanErr);
        return reply(cleanErr.message);
      }
      console.log('Finished cleaning %s, now creating tree: %j', cleanedPath, makeable);
      // Use root for building Relatives first, will map later to Absolute::
      constructLayer(makeable.ParentId, '', makeable.ChildResources,
        function(makeTreeErr, makeTreeSuccess) {
          if (makeTreeErr) {
            console.log('Failed to make tree, FAILURE: ', makeTreeErr);
            return reply(makeTreeErr.message);
          }
          console.log('Made tree, now building GetAtt hash: %j', makeTreeSuccess);
          console.log('Returning hash of GetAtt: %j', idHash);
          reply(null, getPhysicalId(makeable), idHash);
        });
    });

  function constructLayer(parentId, parentPath, children, completedLayer) {
    asyncMap(children.map(function(child) {
      var path = parentPath + '/' + child.PathPart;
      return function(completedChild) {
        makeResource(parentId, child.PathPart, function(err, childResult) {
          if (err) {
            console.log('Error making child %s: %j', path, err);
            return completedChild(err);
          }
          console.log('Constructed resource %s: %j', path, child);
          idHash[path] = childResult.id;
          if (!child.ChildResources) {
            return completedChild(null, childResult);
          }
          console.log('Child %s has children, constructing: %j', path, child.ChildResources);
          constructLayer(childResult.id, path, child.ChildResources, completedChild);
        });
      };
    }), function(layerErr, layerCompletion) {
      if (layerErr) {
        console.log('Layer construction error on %s: %j ',
          parentPath, children);
        return completedLayer(layerErr);
      }
      completedLayer(null, layerCompletion);
    });
  }

  function makeResource(parentId, pathPart, callback, delay) {
    APIG.createResource({
      restApiId: makeable.RestApiId,
      parentId: parentId,
      pathPart: pathPart
    }, function(err, data) {
      var retryDelay = delay || 250;
      if (err && err.statusCode === 429) {
        console.log('Getting throttled! Delaying by %s', retryDelay);
        return setTimeout(function() {
          makeResource(parentId, pathPart, callback, retryDelay * 2);
        }, retryDelay);
      }
      callback(err, data);
    });
  }
}



function Create(params, reply) {
  console.log('CREATE delegating to Upsert.');
  Upsert(params, params, reply);
}

function Update(physicalId, params, oldParams, reply) {
  console.log('UPDATE delegating to Upsert.');
  Upsert(oldParams, params, reply);
}

function Delete(physicalId, params, reply) {
  if (physicalId === getPhysicalId(params)) {
    console.log('Appears this is an UPDATE_CLEANUP, mismatched deletion signature.');
    console.log('Non-deleted stream table: %j', params);
    return reply();
  }
  cleanParent(params.RestApiId, params.ParentId, function(cleanErr, cleanedPath) {
    if (cleanErr && cleanErr.statusCode !== 404) {
      console.log('Failed to clean %s');
      return reply(cleanErr.message);
    }
    console.log('Deleted the subtree: %s', cleanedPath);
    reply();
  });
}

function getPhysicalId(params) {
  var shasum = crypto.createHash('sha256');
  shasum.update(JSON.stringify(params.ChildResources));
  return [
    params.RestApiId,
    params.ParentId,
    shasum.digest('hex')
  ].join('---');
}

function collectResources(restApiId, callback) {

  var pageSize = 500;
  var resources = [];

  console.log('Collecting resources on API: %s', restApiId);
  getResourcePage();

  function getResourcePage(position) {
    console.log('Collecting resource page of up to %s ' +
      'resources at position %s on API %s...',
      pageSize, position || '(first page)', restApiId);
    APIG.getResources({
      restApiId: restApiId,
      limit: pageSize,
      position: position
    }, function(err, resourcePage) {
      if (err) {
        console.error('Error while collecting resources: %j', err);
        return callback(err);
      }
      resources = resources.concat(resourcePage.items);
      // Might need to recurse...
      if (resourcePage.items.length === pageSize) {
        console.log('Found more than one page of %s for resources.', pageSize);
        return getResourcePage(position);
      }
      callback(null, resources);
    });
  }
}

function findById(resources, id) {
  return resources.filter(function(resource) {
    return resource.id === id;
  })[0];
}

function cleanParent(restApiId, parentResourceId, callback) {
  console.log('Triggering API resource collection to help clean: %s', restApiId);
  collectResources(restApiId, function (collectErr, resources) {
    if (collectErr) {
      console.error('Could not clean parent due to ' +
        'fatal resource collection error: %j', collectErr);
      return callback(collectErr);
    }
    console.log('Found batch of Resource objects: %j', resources);
    var parent = findById(resources, parentResourceId);
    if (!parent) {
      console.error('Could not find the ParentId %s ' +
        'in resource set when trying to cleanse, set: %j', parentResourceId, resources);
      return callback({
        message:'Could not find the ParentId ' + parentResourceId +
          ' in resource set when trying to cleanse.'
      });
    }
    var immediateChildResources = resources.filter(function(resource) {
      return resource.path !== '/' && resource.path.indexOf(parent.path) === 0 &&
        parent.path.replace(/^\//, '').split('/').length + 1 ===
          resource.path.split('/').length;
    });
    console.log('Found batch of immediate child Resource ' +
      'objects, commence deletion: %j', immediateChildResources);
    asyncMap(immediateChildResources.map(function(resource) {
      return deleteResource.bind(null, restApiId, resource.id);
    }), function(deleteAllErr, results) {
      if (deleteAllErr) {
        console.error('Error when deleting child resource set: %j', deleteAllErr);
        return callback(deleteAllErr);
      }
      console.log('Cleaned parent resource: %s', parent.path);
      callback(null, parent.path);
    });
  });
}

function computeResourcePaths(node) {
  return flatten(layer('')(node));
  function flatten(list) {
    return [].concat.apply([], list.map(function(item) {
      return Array.isArray(item)
        ? [].concat.apply([], item.map(flatten))
        : item;
    }));
  }
  function layer(prefix) {
    return function(node) {
      console.log(node, node.ChildResources);
      var chunk = node.PathPart
        ? prefix + '/' + node.PathPart
        : '';
      return [
        chunk || '/',
        (node.ChildResources || []).map(layer(chunk))
      ];
    };
  }
}

function NoUpdate(physicalId, params, reply) {
  collectResources(params.RestApiId, function(collectErr, resources) {
    if (collectErr) {
      console.error('Error while collecting resources for API %s while ' +
        ' trying to build GetAtt hash: %j', params.RestApiId, collectErr);
      return reply('Error while collecting resources for API ' +  + ' while ' +
        ' trying to build GetAtt hash: %j', params.RestApiId);
    }
    var parent = findById(resources, params.ParentId);
    if (!parent) {
      console.error('Could not find the ParentId %s ' +
        'in resource set when trying to cleanse, set: %j', params.ParentId, resources);
      return reply('Could not find the ParentId ' + params.ParentId +
        ' in resource set for API ' + params.RestApiId +
        ' when trying to obtain GetAtt hash.');
    }
    console.log('Found parent: %j', parent);
    var resourceIndex = resources.reduce(function(hash, resource) {
      hash[resource.path] = resource;
      return hash;
    }, {});
    console.log('Completed resouce hash: %j', resourceIndex);
    var relevantResourcesSet = computeResourcePaths(params);
    console.log('Resource set for this tree: %j', relevantResourcesSet);
    var relevantResourcesHash = relevantResourcesSet.reduce(function(hash, path) {
      var fullPath = (parent.path + path).replace('//', '/');
      if (resourceIndex[fullPath]) {
        hash[path] = resourceIndex[fullPath].id;
      }
      return hash;
    }, {});
    console.log('Replying with hash: %j', relevantResourcesHash);
    reply(null, physicalId, relevantResourcesHash);
  });
}

function deleteResource(restApiId, resourceId, callback) {
  APIG.deleteResource({
    restApiId: restApiId,
    resourceId: resourceId
  }, function(err, data) {
    if (err && err.statusCode !== 404) {
      console.log('Failed to delete resource: %j', err);
      return callback(err);
    }
    console.log('Initialized cleanse resource %s: %j', resourceId, data);
    waitFor404(restApiId, resourceId, callback);
  });
}

function waitFor404(restApiId, resourceId, callback) {
  console.log('Waiting for %s to actually delete...', resourceId);
  APIG.getResource({
    restApiId: restApiId,
    resourceId: resourceId
  }, function(err, data) {
    if (err && err.statusCode === 404) {
      console.log('Resource %s actually deleted.', resourceId);
      return callback();
    }
    if (err) {
      console.error('Fatal error while waiting for resource %s to delete.', resourceId);
      return callback(err);
    }
    setTimeout(function() {
      waitFor404(restApiId, resourceId, callback);
    }, 100);
  });
}

function asyncMap(actionSet, callback) {
  var results = [];
  var failed = false;
  var completed = 0;
  if (!actionSet.length) {
    return callback(null, []);
  }
  actionSet.forEach(function(action, index) {
    action(function(err, data) {
      if (failed) {
        return;
      }
      if (err) {
        failed = true;
        return callback(err);
      }
      results[index] = data;
      completed++;
      if (completed === actionSet.length) {
        callback(null, results);
      }
    });
  });
}

