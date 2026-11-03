CREATE TABLE `messages` (
	`message_id` text PRIMARY KEY NOT NULL,
	`a2a_task_id` text NOT NULL
);
--> statement-breakpoint
CREATE TABLE `plans` (
	`a2a_task_id` text PRIMARY KEY NOT NULL,
	`plan` text NOT NULL
);
--> statement-breakpoint
CREATE TABLE `runs` (
	`a2a_task_id` text PRIMARY KEY NOT NULL,
	`dovo_task_id` text
);
--> statement-breakpoint
CREATE TABLE `steps` (
	`a2a_task_id` text NOT NULL,
	`step_id` text NOT NULL,
	`worker_task_id` text,
	`state` text,
	`text` text,
	PRIMARY KEY(`a2a_task_id`, `step_id`)
);
--> statement-breakpoint
CREATE TABLE `tasks` (
	`id` text PRIMARY KEY NOT NULL,
	`context_id` text NOT NULL,
	`state` integer,
	`updated_at` text,
	`data` text NOT NULL
);
