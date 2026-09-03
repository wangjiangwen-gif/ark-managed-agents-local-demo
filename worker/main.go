package main

import (
	"context"
	"log"
	"os"
	"time"

	"github.com/volcengine/ark-runtime-go/arkruntime"
	"github.com/volcengine/ark-runtime-go/arkruntime/lib/environments"
)

func main() {
	apiKey := os.Getenv("ARK_API_KEY")
	baseURL := os.Getenv("ARK_BASE_URL")
	environmentID := os.Getenv("MA_ENVIRONMENT_ID")
	workdir := os.Getenv("MA_WORKDIR")
	workerID := os.Getenv("MA_WORKER_ID")
	if apiKey == "" || environmentID == "" || workdir == "" {
		log.Fatal("ARK_API_KEY, MA_ENVIRONMENT_ID and MA_WORKDIR are required")
	}
	if workerID == "" {
		workerID = "local-web-demo-worker"
	}

	options := make([]arkruntime.ConfigOption, 0, 1)
	if baseURL != "" {
		options = append(options, arkruntime.WithBaseUrl(baseURL))
	}
	client := arkruntime.NewClientWithApiKey(apiKey, options...)
	maxIdle := 15 * time.Second
	worker := environments.NewEnvironmentWorkerForClient(client, environments.EnvironmentWorkerOptions{
		EnvironmentID:     environmentID,
		WorkerID:          workerID,
		Workdir:           workdir,
		UnrestrictedPaths: true,
		ToolTimeout:       3 * time.Minute,
		MaxIdle:           &maxIdle,
	})

	log.Printf("worker online: id=%s environment=%s workdir=%s", workerID, environmentID, workdir)
	if err := worker.Run(context.Background()); err != nil {
		log.Fatal(err)
	}
}
