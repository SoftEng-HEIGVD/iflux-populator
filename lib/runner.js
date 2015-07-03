var
	_ = require('underscore'),
	s = require('underscore.string'),
	colors = require('colors');

module.exports = function(copilot) {
	function isSearchOnly(item) {
		return !_.isUndefined(item.searchOnly) && item.searchOnly;
	}

	function Iterator(data) {
		this.data = data;
		this.start = 0;

		this.dataIdx = _.reduce(data, function (memo, value, key) {
			memo.push(key);
			return memo;
		}, []);

		this.next = function () {
			if (this.start < this.dataIdx.length) {
				this.start++;
				return this.data[this.dataIdx[this.start - 1]];
			}
		};

		this.hasNext = function () {
			return this.start < this.dataIdx.length;
		};
	}

	function extractId(response) {
		var locationParts = response.headers.location.split('/');
		return parseInt(locationParts[locationParts.length - 1]);
	}

	function extractGenId(response) {
		return response.headers['x-iflux-generated-id'];
	}

	function jwtRequestFilterFactory(jwtToken) {
		return function (requestOptions) {
			requestOptions.headers = {
				'Authorization': 'bearer ' + jwtToken
			};

			// the filter function must return the updated request options
			return requestOptions;
		}
	}

	var Manager = function (scenario, iterator, itemName, itemPath, options) {
		var manager = this;

		this.iterator = iterator;
		this.itemName = itemName;
		this.itemPath = itemPath;
		this.scenario = scenario;

		if (options) {
			if (options.next) {
				this.next = options.next;
			}

			if (options.extend) {
				this.extend = options.extend;
			}

			if (options.getUrl) {
				this.getUrl = options.getUrl;
			}
		}

		this.iterate = function () {
			if (manager.iterator.hasNext()) {
				return manager.find(manager.iterator.next());
			}
			else {
				//return iterateActionTypes();
				if (manager.next) {
					if (_.isFunction(manager.next)) {
						return manager.next();
					}
					else {
						return manager.next.iterate();
					}
				}
			}
		};

		this.find = function (item, retry) {
			var retryText = retry ? 'retry: ' : '';

			return this.scenario
				.step(retryText + 'find ' + manager.itemName + ': ' + item.data.name, function () {
					var baseGetUrl = '/' + manager.itemPath + '?name=' + item.data.name;
					return this.get({
						url: manager.getUrl ? manager.getUrl(item, baseGetUrl) : baseGetUrl
					});
				})
				.step(retryText + 'check ' + manager.itemName + ' found: ' + item.data.name, function (response) {
					if (item.searchOnly) {
						if (response.statusCode == 200 && response.body.length == 1) {
							item.id = response.body[0].id;
							console.log('%s found with id: %s'.green, manager.itemName, item.id);
							manager.iterate();
						}
						else {
							console.log('%s: %s not found.'.red, manager.itemName, item.data.name);
						}
					}
					else {
						if (response.statusCode == 200 && response.body.length == 1) {
							item.id = response.body[0].id;
							console.log('%s found with id: %s'.green, manager.itemName, item.id);
							return manager.update(item);
						}
						else {
							console.log('%s: %s not found.'.yellow, manager.itemName, item.data.name);
							return manager.create(item);
						}
					}
				})
		};

		this.create = function (item) {
			return this.scenario
				.step('try to create ' + manager.itemName + ': ' + item.data.name, function () {
					var data = manager.extend ? manager.extend(item) : item.data;

					return this.post({
						url: '/' + manager.itemPath,
						body: data,
					});
				})
				.step('check ' + manager.itemName + ' created for: ' + item.data.name, function (response) {
					if (response.statusCode == 201) {
						item.id = extractId(response);
						console.log('%s created with id: %s'.green, manager.itemName, item.id);
						return manager.iterate();
					}

					else if (response.statusCode == 500 && response.body.message && response.body.message == 'Unable to configure the remote action target.') {
						console.log('An error has occured in the creation of %s'.yellow, item.data.name);
						console.log('%s'.yellow, response.body.message);
						console.log('The iFLUX system may not behave as you expected.');
						return manager.find(item, true);
					}

					else {
						console.log('An error has occured in the creation of %s'.red, item.data.name);
						console.log(item.data);
						console.log(JSON.stringify(response.body));
					}
				});
		};

		this.update = function (item) {
			return this.scenario
				.step('try to update ' + manager.itemName + ': ' + item.data.name, function () {
					return this.patch({
						url: '/' + manager.itemPath + '/' + item.id,
						body: manager.extend ? manager.extend(item) : item.data
					});
				})
				.step('check ' + manager.itemName + ' updated for: ' + item.data.name, function (response) {
					if (response.statusCode == 201) {
						console.log('%s %s updated.'.green, manager.itemName, item.data.name);
					}

					else if (response.statusCode == 304) {
						console.log('nothing updated on %s %s'.yellow, manager.itemName, item.data.name);
					}

					else if (response.statusCode == 500 && response.body.message && response.body.message == 'Unable to configure the remote action target.') {
						console.log('An error has occured in the creation of %s'.yellow, item.data.name);
						console.log('%s'.yellow, response.body.message);
						console.log('The iFLUX system may not behave as you expected.');
						return manager.find(item, true);
					}

					else {
						console.log('There is an error: %s'.red, response.statusCode);
						console.log(JSON.stringify(response.body));
					}

					return manager.iterate();
				});
		}
	};

	function Runner(options) {
		this.scenario = new copilot.Scenario(options);
		this.dataCollections = {};
		this.managers = {};
	};

	_.each(['EventSourceTemplates', 'EventTypes', 'EventSources', 'ActionTargetTemplates', 'ActionTypes', 'ActionTargets', 'Rules'], function (collectionName) {
		Runner.prototype['add' + collectionName] = function (collection) {
			if (this.dataCollections[collectionName]) {
				console.log('Data collection: %s already defined.', collectionName);
			}
			else {
				this.dataCollections[collectionName] = new Iterator(collection);
			}
		}
	});

	_.extend(Runner.prototype, {
		addParams: function (params) {
			_.each(params, function (param, name) {
				this.scenario.addParam(name, param);
			}, this);
		},

		run: function (options) {
			var runner = this;

			this._beforeRun();

			this.scenario
				.step('configure base URL', function () {
					return this.configure({baseUrl: this.param(options.baseUrlParam)});
				})
				.step('make sure all the data are well prepared.', function () {
					_.each(runner.dataCollections.EventSourceTemplates.data, function (eventSourceTemplate) {
						if (!isSearchOnly(item)) {
							eventSourceTemplate.data.organizationId = this.organizationId;

							if (eventSourceTemplate.data.configuration && _.isFunction(eventSourceTemplate.data.configuration.url)) {
								eventSourceTemplate.data.configuration.url = _.bind(eventSourceTemplate.data.configuration.url, this)();
							}
						}
					}, this);

					_.each(runner.dataCollections.EventSources.data, function (eventSource) {
						if (!isSearchOnly(item)) {
							eventSource.data.organizationId = this.organizationId;

							if (eventSource.data.configuration && _.isFunction(eventSource.data.configuration)) {
								eventSource.data.configuration = _.bind(eventSource.data.configuration, this)();
							}
						}
					}, this);

					_.each(runner.dataCollections.ActionTargetTemplates.data, function (actionTargetTemplate) {
						if (!isSearchOnly(actionTargetTemplate)) {
							actionTargetTemplate.data.organizationId = this.organizationId;

							if (actionTargetTemplate.data.configuration && _.isFunction(actionTargetTemplate.data.configuration.url)) {
								actionTargetTemplate.data.configuration.url = _.bind(actionTargetTemplate.data.configuration.url, this)();
							}

							if (_.isFunction(actionTargetTemplate.data.target.url)) {
								actionTargetTemplate.data.target.url = _.bind(actionTargetTemplate.data.target.url, this)();
							}
						}
					}, this);

					_.each(runner.dataCollections.ActionTargets.data, function (actionTarget) {
						if (!isSearchOnly(actionTarget)) {
							actionTarget.data.organizationId = this.organizationId;

							if (actionTarget.data.configuration && _.isFunction(actionTarget.data.configuration)) {
								actionTarget.data.configuration = _.bind(actionTarget.data.configuration, this)();
							}
						}
					}, this);

					_.each(runner.dataCollections.EventTypes.data, function (eventType) {
						if (!isSearchOnly(item)) {
							eventType.data.organizationId = this.organizationId;
							eventType.data.type = _.bind(eventType.data.type, this)();
						}
					}, this)

					_.each(runner.dataCollections.ActionTypes.data, function (actionType) {
						if (!isSearchOnly(item)) {
							actionType.data.organizationId = this.organizationId;
							actionType.data.type = _.bind(actionType.data.type, this)();
						}
					}, this)
				});

			this._signin('first attempt to signing', options.userParam, options.passwordParam)
				.step('check authentication done', function (response) {
					if (response.statusCode == 401) {
						return register();
					}
					else {
						this.addRequestFilter(jwtRequestFilterFactory(response.body.token));
						return runner._findOrganization('after first attempt to signin', options.orgaName);
					}
				});

			return this.scenario;
		},

		_beforeRun: function () {
			var runner = this;

			this.managers.ruleManager = new Manager(this.scenario, this.dataCollections['Rules'], 'rule', 'rules', {
				next: _.bind(this._logging, this),
				extend: function (item) {
					return _.extend(item.data, {organizationId: runner.organizationId});
				}
			});

			this.managers.actionTargetManager = new Manager(this.scenario, this.dataCollections['ActionTargets'], 'action target', 'actionTargets', {
				next: _.bind(this._prepareRules, this),
				getUrl: function (item, baseGetUrl) {
					return baseGetUrl + '&actionTargetTemplateId=' + item.template.id
				},
				extend: function (item) {
					return _.extend(item.data, {
						organizationId: runner.organizationId,
						actionTargetTemplateId: item.template.id
					});
				}
			});

			this.managers.actionTypeManager = new Manager(this.scenario, this.dataCollections['ActionTypes'], 'action type', 'actionTypes', {next: this.managers.actionTargetManager});

			this.managers.actionTargetTemplateManager = new Manager(this.scenario, this.dataCollections['ActionTargetTemplates'], 'action target template', 'actionTargetTemplates', {
				next: this.managers.actionTypeManager,
				extend: function (item) {
					return _.extend(item.data, {
						organizationId: runner.organizationId,
					});
				}
			});

			this.managers.eventSourceManager = new Manager(this.scenario, this.dataCollections['EventSources'], 'event source', 'eventSources', {
				next: this.managers.actionTargetTemplateManager,
				getUrl: function (item, baseGetUrl) {
					return baseGetUrl + '&eventSourceTemplateId=' + item.template.id
				},
				extend: function (item) {
					return _.extend(item.data, {
						organizationId: runner.organizationId,
						eventSourceTemplateId: item.template.id
					});
				}
			});

			this.managers.eventTypeManager = new Manager(this.scenario, this.dataCollections['EventTypes'], 'event type', 'eventTypes', {next: this.managers.eventSourceManager});

			this.managers.eventSourceTemplateManager = new Manager(this.scenario, this.dataCollections['EventSourceTemplates'], 'event source template', 'eventSourceTemplates', {
				next: this.managers.eventTypeManager,
				extend: function (item) {
					return _.extend(item.data, {
						organizationId: runner.organizationId,
					});
				}
			});
		},

		_signin: function (label, userParam, passwordParam) {
			return this.scenario
				.step(label, function () {
					return this.post({
						url: '/auth/signin',
						body: {
							email: this.param(userParam),
							password: this.param(passwordParam)
						}
					});
				});
		},

		_register: function (userParam, passwordParam, organName) {
			var runner = this;

			return this.scenario
				.step('register user', function () {
					return this.post({
						url: '/auth/register',
						body: {
							lastName: "Admin",
							firstName: "Admin",
							email: this.param(userParam),
							password: this.param(passwordParam),
							passwordConfirmation: this.param(passwordParam)
						},
						expect: {
							statusCode: 201
						}
					});
				})
				.step('check registration', function () {
					return runner._signin('second try to signing after registration', userParam, passwordParam)
						.step('store token', function (response) {
							this.addRequestFilter(jwtRequestFilterFactory(response.body.token));
							return runner._findOrganization('after registration', orgaName);
						});
				})
		},

		_findOrganization: function (label, orgaName) {
			var runner = this;

			return this.scenario
				.step('try to retrieve the organization ' + orgaName + ': ' + label, function () {
					return this.get({
						url: '/organizations?name=' + orgaName
					});
				})
				.step('check organization retrieved: ' + label, function (response) {
					if (response.statusCode == 200 && response.body.length == 1) {
						runner.organizationId = response.body[0].id;
						console.log('organization found with id: %s'.green, runner.organizationId);

						return runner.managers.eventSourceTemplateManager.iterate();
					}
					else {
						console.log('unable to retrieve the organization: %s'.yellow, orgaName);
						return runner._createOrganization(orgaName);
					}
				})
		},

		_createOrganization: function (orgaName) {
			var runner = this;

			return this.scenario
				.step('try to create organization', function () {
					return this.post({
						url: '/organizations',
						body: {
							name: orgaName
						},
						expect: {
							statusCode: 201
						}
					});
				})
				.step('check organization created', function (response) {
					runner.organizationId = extractId(response);
					console.log('organization created with id: %s'.green, organizationId);

					return runner.managers.eventSourceTemplateManager.iterate();
				});
		},

		_prepareRules: function () {
			var runner = this;

			this.scenario
				.step('prepare the rules.', function () {
					_.each(runner.dataCollections.Rules.data, function (rule, key) {
						if (s.contains(key.toLowerCase(), 'slack')) {
							rule.data.active = this.param('slack_active');
						}

						_.each(rule.data.conditions, function (condition) {
							if (condition.eventSourceId) {
								condition.eventSourceId = condition.eventSourceId.id;
							}

							if (condition.eventTypeId) {
								condition.eventTypeId = condition.eventTypeId.id;
							}
						}, this);

						_.each(rule.data.transformations, function (transformation) {
							if (transformation.actionTargetId) {
								transformation.actionTargetId = transformation.actionTargetId.id;
							}

							if (transformation.actionTypeId) {
								transformation.actionTypeId = transformation.actionTypeId.id;
							}

							if (transformation.eventTypeId) {
								transformation.eventTypeId = transformation.eventTypeId.id;
							}

							if (transformation.fn && transformation.fn.sample && transformation.fn.sample.eventSourceTemplateId) {
								transformation.fn.sample.eventSourceTemplateId = transformation.fn.sample.eventSourceTemplateId.id;
							}
						}, this);
					}, this);
				});

			return this.managers.ruleManager.iterate();
		},

		_logging: function () {
			var runner = this;

			return this.scenario
				.step('logging', function () {
					_.each(runner.dataCollections, function (dataCollection, name) {
						console.log(name);
						console.log(dataCollection);
						console.log('------------------------');
					});
				});
		}

	});

	return Runner;
}
module.exports['@require'] = [ 'api-copilot' ];